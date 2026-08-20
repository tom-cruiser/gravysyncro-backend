const mongoose = require('mongoose');
const AppError = require('../utils/appError');
const {
  LIFECYCLE_STATES,
  applyLifecycleLock,
  getLockedMutationPaths,
  isPrivilegedAssetActor,
} = require('../utils/assetLifecycle');
const { logAssetActivity } = require('../services/assetActivityLogger');

// Mirrors Video.js in shape (same lifecycle/locking/access-control model, so
// audio clips inherit the exact same archiving and permission behaviour as
// documents and videos), but uses a single-shot upload like Document.js
// instead of Video's resumable multipart flow — voice memos and meeting
// recordings are comfortably within a normal request body size, so the
// extra multipart machinery isn't needed here.
const audioSchema = new mongoose.Schema({
  // Multi-tenant
  tenantId: {
    type: String,
    required: true,
    index: true,
  },

  // Owner
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  uploadedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true,
  },

  // File info
  title: { type: String, required: true, trim: true },
  description: { type: String, trim: true, default: '' },
  fileName: { type: String, required: true },
  originalName: { type: String, required: true },
  mimeType: { type: String, required: true },
  fileSize: { type: Number, required: true },
  fileExtension: { type: String, required: true },
  // Playback length in whole seconds. Populated client-side (from the
  // recorder or from the uploaded file's decoded metadata) since decoding
  // audio duration server-side would need an extra native dependency.
  duration: { type: Number, default: 0 },
  // True when captured via the in-app recorder (getUserMedia/MediaRecorder)
  // rather than uploaded as an existing file — purely informational.
  recordedLive: { type: Boolean, default: false },

  // Storage
  storageKey: { type: String, required: true, unique: true },
  checksum: { type: String, required: true },

  // Organisation
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workspace',
    index: true,
    default: null,
  },
  folderId: { type: String, default: null },
  folderPath: { type: String, default: '' },
  category: { type: String, default: 'General' },
  tags: [{ type: String, trim: true }],

  // Sharing
  isShared: { type: Boolean, default: false },
  sharedWith: [{
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    permission: { type: String, enum: ['view', 'edit', 'admin'], default: 'view' },
    sharedAt: { type: Date, default: Date.now },
    sharedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  }],

  lifecycleState: {
    type: String,
    enum: LIFECYCLE_STATES,
    default: 'STARTED',
    index: true,
  },
  lifecycleLocked: {
    type: Boolean,
    default: false,
    index: true,
  },
  lifecycleStateUpdatedAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
  lockedAt: {
    type: Date,
    default: null,
  },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: Date,
  deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // Access tracking
  accessCount: { type: Number, default: 0 },
  downloadCount: { type: Number, default: 0 },
  lastAccessedAt: Date,
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

audioSchema.index({ tenantId: 1, owner: 1 });
audioSchema.index({ tenantId: 1, lifecycleState: 1, createdAt: -1 });
audioSchema.index({ tenantId: 1, workspaceId: 1, createdAt: -1 });
audioSchema.index({ tenantId: 1, createdAt: -1 });
audioSchema.index({ title: 'text', description: 'text', tags: 'text' });

audioSchema.virtual('fileSizeFormatted').get(function () {
  const bytes = this.fileSize;
  if (!bytes) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
});

audioSchema.virtual('durationFormatted').get(function () {
  const totalSeconds = Math.max(Math.round(this.duration || 0), 0);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
});

audioSchema.methods.hasAccess = function (userId, requiredPermission = 'view') {
  const ownerId = this.owner || this.uploadedBy;
  if (ownerId && ownerId.toString() === userId.toString()) return true;
  const entry = this.sharedWith.find((e) => e.user.toString() === userId.toString());
  if (!entry) return false;
  if (requiredPermission === 'view') return ['view', 'edit', 'admin'].includes(entry.permission);
  if (requiredPermission === 'edit') return ['edit', 'admin'].includes(entry.permission);
  return entry.permission === 'admin';
};

audioSchema.pre('save', function (next) {
  const lockingTransition = this.isModified('lifecycleState') && ['FINISHED', 'ARCHIVED'].includes(this.lifecycleState);
  applyLifecycleLock(this);

  if (!this.isNew && this.lifecycleLocked) {
    const protectedPaths = getLockedMutationPaths(this).filter((path) => {
      if (lockingTransition && ['lifecycleState', 'lifecycleLocked', 'lockedAt', 'lifecycleStateUpdatedAt'].includes(path)) {
        return false;
      }
      return true;
    });

    if (protectedPaths.length > 0 && !isPrivilegedAssetActor(this.$locals?.currentUser)) {
      return next(new AppError('This audio clip is locked and can only be updated or deleted by an admin or manager.', 403));
    }
  }

  return next();
});

audioSchema.pre('deleteOne', { document: true, query: false }, function (next) {
  if (this.lifecycleLocked && !isPrivilegedAssetActor(this.$locals?.currentUser)) {
    return next(new AppError('This audio clip is locked and can only be deleted by an admin or manager.', 403));
  }

  return next();
});

audioSchema.post('save', async function (doc, next) {
  try {
    const context = doc.$locals?.assetActivity;
    const currentUser = doc.$locals?.currentUser;

    if (context && currentUser?._id) {
      await logAssetActivity({
        tenantId: doc.tenantId,
        workspaceId: doc.workspaceId || null,
        userId: currentUser._id,
        assetId: doc._id,
        assetType: 'Audio',
        action: context.action,
        previousState: context.previousState ?? null,
        newState: context.newState ?? doc.lifecycleState,
        details: context.details || {},
      });
    }

    next();
  } catch (error) {
    next(error);
  }
});

module.exports = mongoose.model('Audio', audioSchema);
