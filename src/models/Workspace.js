const mongoose = require('mongoose');

const workspaceMemberSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  permission: {
    type: String,
    enum: ['manager', 'member', 'guest'],
    default: 'member',
  },
  invitedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  invitedAt: {
    type: Date,
    default: Date.now,
  },
}, { _id: false });

const workspaceSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  label: {
    type: String,
    default: 'Workspace',
  },
  clientName: {
    type: String,
    trim: true,
    default: '',
  },
  status: {
    type: String,
    enum: ['active', 'archived'],
    default: 'active',
  },
  reworkEnabled: {
    type: Boolean,
    default: false,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  manager: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  members: [workspaceMemberSchema],
  guests: [workspaceMemberSchema],
  archivedAt: Date,
  description: {
    type: String,
    default: '',
    trim: true,
  },
}, { timestamps: true });

workspaceSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
workspaceSchema.index({ tenantId: 1, manager: 1 });
workspaceSchema.index({ tenantId: 1, 'members.user': 1 });
workspaceSchema.index({ tenantId: 1, 'guests.user': 1 });

module.exports = mongoose.model('Workspace', workspaceSchema);