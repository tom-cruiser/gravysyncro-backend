const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema({
  // Multi-tenant identifier
  tenantId: {
    type: String,
    required: true,
    index: true,
  },
  
  // User who performed the action
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  
  // Action details
  action: {
    type: String,
    required: true,
    enum: [
      'UPLOAD',
      'STATE_CHANGE',
      'DOWNLOAD',
      'VIEW',
      'login',
      'logout',
      'register',
      'password_change',
      'profile_update',
      'document_upload',
      'document_view',
      'document_download',
      'document_edit',
      'document_delete',
      'document_share',
      'document_unshare',
      'comment_add',
      'comment_edit',
      'comment_delete',
      'permission_change',
      'settings_change',
      'video_upload',
      'video_view',
      'video_download',
      'video_delete',
      'video_permanent_delete',
    ],
  },

  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workspace',
    index: true,
    default: null,
  },

  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true,
    required() {
      return ['UPLOAD', 'STATE_CHANGE', 'DOWNLOAD', 'VIEW'].includes(this.action);
    },
  },

  assetId: {
    type: mongoose.Schema.Types.ObjectId,
    index: true,
    required() {
      return ['UPLOAD', 'STATE_CHANGE', 'DOWNLOAD', 'VIEW'].includes(this.action);
    },
  },

  assetType: {
    type: String,
    enum: ['Document', 'Video'],
    required() {
      return ['UPLOAD', 'STATE_CHANGE', 'DOWNLOAD', 'VIEW'].includes(this.action);
    },
  },

  previousState: {
    type: String,
  },

  newState: {
    type: String,
  },

  timestamp: {
    type: Date,
    default: Date.now,
    index: true,
  },
  
  // Resource affected
  resourceType: {
    type: String,
    enum: ['user', 'document', 'comment', 'tenant', 'system', 'video'],
  },
  resourceId: {
    type: mongoose.Schema.Types.ObjectId,
  },
  
  // Details
  details: {
    type: Object,
    default: {},
  },
  
  // Request information
  ipAddress: String,
  userAgent: String,
  
  // Status
  status: {
    type: String,
    enum: ['success', 'failure', 'warning'],
    default: 'success',
  },
  errorMessage: String,
}, {
  timestamps: true,
});

// Indexes
activityLogSchema.index({ tenantId: 1, createdAt: -1 });
activityLogSchema.index({ tenantId: 1, user: 1, createdAt: -1 });
activityLogSchema.index({ tenantId: 1, action: 1 });
activityLogSchema.index({ tenantId: 1, timestamp: -1 });
activityLogSchema.index({ tenantId: 1, workspaceId: 1, timestamp: -1 });
activityLogSchema.index({ tenantId: 1, assetType: 1, assetId: 1, timestamp: -1 });

// TTL index to auto-delete old logs (optional - 90 days)
activityLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 });

module.exports = mongoose.model('ActivityLog', activityLogSchema);
