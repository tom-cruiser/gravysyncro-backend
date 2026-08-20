const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  // Multi-tenant identifier
  tenantId: {
    type: String,
    required: true,
    index: true,
  },
  
  // Where this message came from. Public contact-form submissions have
  // no logged-in user/tenant, so this flag is what lets the rest of the
  // schema (and the admin UI) treat them differently.
  source: {
    type: String,
    enum: ['app', 'public_contact_form'],
    default: 'app',
    index: true,
  },

  // User who sent the message — only present for in-app (authenticated)
  // messages. A public contact-form visitor has no account, so this is
  // conditionally required rather than always required.
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: function () { return this.source !== 'public_contact_form'; },
    index: true,
  },

  // Snapshot of the visitor's own contact details, only populated for
  // public_contact_form messages (there's no User document to look this
  // up from later).
  visitor: {
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true },
  },

  // Message details
  subject: {
    type: String,
    required: true,
    trim: true,
    maxlength: 200,
  },
  
  message: {
    type: String,
    required: true,
    trim: true,
  },
  
  // Status
  status: {
    type: String,
    enum: ['pending', 'in_progress', 'resolved', 'closed'],
    default: 'pending',
    index: true,
  },
  
  // Priority
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium',
  },
  
  // Admin response
  response: {
    type: String,
    trim: true,
  },
  
  respondedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  
  respondedAt: {
    type: Date,
  },
  
  // Category
  category: {
    type: String,
    enum: ['technical', 'billing', 'feature_request', 'bug_report', 'general', 'other'],
    default: 'general',
  },
  
  // Read status
  isRead: {
    type: Boolean,
    default: false,
    index: true,
  },
}, {
  timestamps: true,
});

// Indexes
messageSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
messageSchema.index({ user: 1, createdAt: -1 });
messageSchema.index({ status: 1, isRead: 1 });

module.exports = mongoose.model('Message', messageSchema);
