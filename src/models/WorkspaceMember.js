const mongoose = require('mongoose');

const workspaceMemberSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true,
  },
  workspace: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workspace',
    required: true,
    index: true,
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  role: {
    type: String,
    enum: ['Workspace Manager', 'Contributor', 'Guest'],
    required: true,
    index: true,
  },
  invitedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  isActive: {
    type: Boolean,
    default: true,
    index: true,
  },
  invitedAt: {
    type: Date,
    default: Date.now,
  },
}, {
  timestamps: true,
});

workspaceMemberSchema.index({ tenantId: 1, workspace: 1, user: 1 }, { unique: true });
workspaceMemberSchema.index({ tenantId: 1, user: 1, isActive: 1 });

module.exports = mongoose.model('WorkspaceMember', workspaceMemberSchema);