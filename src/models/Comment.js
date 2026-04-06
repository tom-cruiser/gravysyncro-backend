const mongoose = require('mongoose');

const commentSchema = new mongoose.Schema({
  // Multi-tenant identifier
  tenantId: {
    type: String,
    required: true,
    index: true,
  },
  
  // Document reference
  document: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Document',
    index: true,
  },

  // Video reference (for video conversation threads)
  video: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Video',
    index: true,
    default: null,
  },
  
  // Author
  author: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  
  // Comment content
  text: {
    type: String,
    required: [true, 'Comment text is required'],
    trim: true,
  },
  
  // Parent comment for threading
  parentComment: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Comment',
    default: null,
  },
  
  // Editing
  edited: {
    type: Boolean,
    default: false,
  },
  editedAt: Date,
  
  // Status
  status: {
    type: String,
    enum: ['active', 'deleted'],
    default: 'active',
  },
  
  // Reactions
  reactions: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    type: {
      type: String,
      enum: ['like', 'love', 'helpful'],
    },
  }],
}, {
  timestamps: true,
});

// Indexes
commentSchema.index({ tenantId: 1, document: 1, createdAt: -1 });
commentSchema.index({ tenantId: 1, video: 1, createdAt: -1 });
commentSchema.index({ author: 1 });

// Ensure comment always belongs to exactly one resource type.
commentSchema.pre('validate', function(next) {
  const hasDocument = !!this.document;
  const hasVideo = !!this.video;

  if ((hasDocument && hasVideo) || (!hasDocument && !hasVideo)) {
    return next(new Error('Comment must reference either a document or a video.'));
  }

  next();
});

module.exports = mongoose.model('Comment', commentSchema);
