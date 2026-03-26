const mongoose = require('mongoose');

const videoSchema = new mongoose.Schema({
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

  // Storage
  storageKey: { type: String, required: true, unique: true },
  checksum: { type: String }, // SHA-256 hex, set after upload completes

  // Multipart upload tracking (S3 multipart)
  uploadId: { type: String }, // S3 UploadId, null after completion
  uploadStatus: {
    type: String,
    enum: ['pending', 'uploading', 'complete', 'failed', 'aborted'],
    default: 'pending',
    index: true,
  },
  // Parts already uploaded (for resume)
  uploadedParts: [{
    PartNumber: Number,
    ETag: String,
  }],

  // Organisation
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

  // Status
  status: {
    type: String,
    enum: ['active', 'archived', 'deleted'],
    default: 'active',
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

videoSchema.index({ tenantId: 1, owner: 1 });
videoSchema.index({ tenantId: 1, uploadStatus: 1 });
videoSchema.index({ tenantId: 1, createdAt: -1 });
videoSchema.index({ title: 'text', description: 'text', tags: 'text' });

videoSchema.virtual('fileSizeFormatted').get(function () {
  const bytes = this.fileSize;
  if (!bytes) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
});

videoSchema.methods.hasAccess = function (userId, requiredPermission = 'view') {
  const ownerId = this.owner || this.uploadedBy;
  if (ownerId && ownerId.toString() === userId.toString()) return true;
  const entry = this.sharedWith.find(e => e.user.toString() === userId.toString());
  if (!entry) return false;
  if (requiredPermission === 'view') return ['view', 'edit', 'admin'].includes(entry.permission);
  if (requiredPermission === 'edit') return ['edit', 'admin'].includes(entry.permission);
  return entry.permission === 'admin';
};

module.exports = mongoose.model('Video', videoSchema);
