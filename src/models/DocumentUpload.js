const mongoose = require('mongoose');

const documentUploadSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true,
  },
  uploadedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workspace',
    default: null,
    index: true,
  },
  folderId: {
    type: String,
    default: null,
  },
  folderPath: {
    type: String,
    default: '',
  },
  relativePath: {
    type: String,
    default: '',
  },
  title: {
    type: String,
    default: '',
  },
  description: {
    type: String,
    default: '',
  },
  type: {
    type: String,
    default: 'General',
  },
  category: {
    type: String,
    default: 'General',
  },
  tags: [{
    type: String,
    trim: true,
  }],
  fileName: {
    type: String,
    required: true,
  },
  originalName: {
    type: String,
    required: true,
  },
  mimeType: {
    type: String,
    required: true,
  },
  fileSize: {
    type: Number,
    required: true,
  },
  fileExtension: {
    type: String,
    required: true,
  },
  storageKey: {
    type: String,
    required: true,
    unique: true,
  },
  uploadId: {
    type: String,
    required: true,
    unique: true,
  },
  uploadStatus: {
    type: String,
    enum: ['pending', 'uploading', 'complete', 'failed', 'aborted'],
    default: 'pending',
    index: true,
  },
  uploadedParts: [{
    PartNumber: Number,
    ETag: String,
  }],
  documentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Document',
    default: null,
    index: true,
  },
  isDeleted: {
    type: Boolean,
    default: false,
    index: true,
  },
  deletedAt: {
    type: Date,
    default: null,
  },
  deletedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  completedAt: {
    type: Date,
    default: null,
  },
}, {
  timestamps: true,
});

documentUploadSchema.index({ tenantId: 1, uploadedBy: 1, createdAt: -1 });
documentUploadSchema.index({ tenantId: 1, uploadStatus: 1, createdAt: -1 });

documentUploadSchema.methods.canUserAccess = function (userId) {
  if (!userId) return false;
  return this.uploadedBy && this.uploadedBy.toString() === userId.toString();
};

module.exports = mongoose.model('DocumentUpload', documentUploadSchema);
