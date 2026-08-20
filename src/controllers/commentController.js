const Comment = require('../models/Comment');
const Document = require('../models/Document');
const Video = require('../models/Video');
const Audio = require('../models/Audio');
const User = require('../models/User');
const Workspace = require('../models/Workspace');
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const { log } = require('../middleware/activityLogger');
const { sendCommentNotificationEmail } = require('../services/emailService');
const { createNotification } = require('./notificationController');
const { emitTenantEvent } = require('../config/socket');
const {
  isEnterpriseAdmin,
  canAccessWorkspace,
  canViewWorkspaceDocument,
} = require('../utils/workspaceAccess');

const buildThreadTree = (comments = []) => {
  const nodes = new Map();
  const roots = [];

  comments.forEach((comment) => {
    nodes.set(comment._id.toString(), { ...comment.toObject(), replies: [] });
  });

  comments.forEach((comment) => {
    const node = nodes.get(comment._id.toString());
    const parentId = comment.parentComment ? comment.parentComment.toString() : null;
    if (parentId && nodes.has(parentId)) {
      nodes.get(parentId).replies.push(node);
    } else {
      roots.push(node);
    }
  });

  return roots;
};

// Resolves which single resource a comment request targets, from whichever
// of :documentId / :videoId / :audioId is present on the route.
const resolveCommentTarget = (params) => {
  const { documentId, videoId, audioId } = params;
  const provided = [documentId, videoId, audioId].filter(Boolean);

  if (provided.length === 0) {
    throw new AppError('A target document, video, or audio clip is required', 400);
  }
  if (provided.length > 1) {
    throw new AppError('Comment target must be exactly one of: document, video, or audio', 400);
  }

  if (videoId) return { kind: 'video', targetId: videoId };
  if (audioId) return { kind: 'audio', targetId: audioId };
  return { kind: 'document', targetId: documentId };
};

/**
 * Add comment to document, video, or audio clip
 */
exports.addComment = catchAsync(async (req, res, next) => {
  const content = req.body.content || req.body.text;
  const parentId = req.body.parentId || req.body.parentComment;
  const { kind, targetId } = resolveCommentTarget(req.params);

  let document = null;
  let video = null;
  let audio = null;
  let workspace = null;
  let targetName = 'resource';

  if (kind === 'video') {
    video = await Video.findOne({
      _id: targetId,
      tenantId: req.user.tenantId,
      isDeleted: false,
      uploadStatus: 'complete',
    });

    if (!video) {
      return next(new AppError('Video not found', 404));
    }

    // Video conversations are tenant-collaborative: any authenticated user
    // in the same tenant may participate in the thread.
    targetName = video.title || video.fileName || 'video';
  } else if (kind === 'audio') {
    audio = await Audio.findOne({
      _id: targetId,
      tenantId: req.user.tenantId,
      isDeleted: false,
    }).populate('uploadedBy');

    if (!audio) {
      return next(new AppError('Audio clip not found', 404));
    }

    const canView = audio.hasAccess(req.user._id, 'view') || await canViewWorkspaceDocument(req, audio);
    if (!canView) {
      return next(new AppError('You do not have permission to comment on this audio clip', 403));
    }

    workspace = audio.workspaceId
      ? await Workspace.findOne({ _id: audio.workspaceId, tenantId: req.user.tenantId })
      : null;

    if (workspace) {
      const canAccess = await canAccessWorkspace(req, workspace._id);
      if (!canAccess) {
        return next(new AppError('You do not have permission to comment on this workspace', 403));
      }

      if (workspace.status === 'archived' && !workspace.reworkEnabled) {
        return next(new AppError('This workspace is archived and read-only', 403));
      }
    }

    targetName = audio.title || audio.fileName || 'audio clip';
  } else {
    // Check if document exists and user has access
    document = await Document.findOne({
      _id: targetId,
      tenantId: req.user.tenantId,
      isDeleted: false,
    }).populate('uploadedBy');

    if (!document) {
      return next(new AppError('Document not found', 404));
    }

    // Check permissions
    const canView = document.canUserAccess(req.user._id, 'view') || await canViewWorkspaceDocument(req, document);
    if (!canView) {
      return next(new AppError('You do not have permission to comment on this document', 403));
    }

    workspace = document.workspaceId
      ? await Workspace.findOne({ _id: document.workspaceId, tenantId: req.user.tenantId })
      : null;

    if (workspace) {
      const canAccess = await canAccessWorkspace(req, workspace._id);
      if (!canAccess) {
        return next(new AppError('You do not have permission to comment on this workspace', 403));
      }

      if (workspace.status === 'archived' && !workspace.reworkEnabled) {
        return next(new AppError('This workspace is archived and read-only', 403));
      }
    }

    targetName = document.name || document.title || 'document';
  }

  // If it's a reply, check if parent comment exists
  if (parentId) {
    const parentComment = await Comment.findOne({
      _id: parentId,
      [kind]: targetId,
      tenantId: req.user.tenantId,
    });

    if (!parentComment) {
      return next(new AppError('Parent comment not found', 404));
    }
  }

  // Create comment
  const comment = await Comment.create({
    tenantId: req.user.tenantId,
    document: kind === 'document' ? targetId : null,
    video: kind === 'video' ? targetId : null,
    audio: kind === 'audio' ? targetId : null,
    author: req.user._id,
    text: content,
    parentComment: parentId || null,
  });

  // Populate author
  await comment.populate('author', 'firstName lastName email');

  const recipientIds = new Set();
  if (kind === 'video') {
    const videoOwnerId = (video.owner || video.uploadedBy)?.toString();
    if (videoOwnerId && videoOwnerId !== req.user._id.toString()) {
      recipientIds.add(videoOwnerId);
    }
    (video.sharedWith || []).forEach((entry) => {
      if (entry?.user) recipientIds.add(entry.user.toString());
    });

    // Include everyone already participating in this video thread.
    const participantIds = await Comment.distinct('author', {
      tenantId: req.user.tenantId,
      video: targetId,
    });
    participantIds.forEach((participantId) => {
      if (participantId) recipientIds.add(participantId.toString());
    });
  } else if (kind === 'audio') {
    if (audio.uploadedBy && audio.uploadedBy._id.toString() !== req.user._id.toString()) {
      recipientIds.add(audio.uploadedBy._id.toString());
    }
    if (workspace) {
      (workspace.members || []).forEach((member) => recipientIds.add(member.user.toString()));
      (workspace.guests || []).forEach((guest) => recipientIds.add(guest.user.toString()));
      if (workspace.manager) recipientIds.add(workspace.manager.toString());
    }
  } else {
    if (document.uploadedBy && document.uploadedBy._id.toString() !== req.user._id.toString()) {
      recipientIds.add(document.uploadedBy._id.toString());
    }
    if (workspace) {
      (workspace.members || []).forEach((member) => recipientIds.add(member.user.toString()));
      (workspace.guests || []).forEach((guest) => recipientIds.add(guest.user.toString()));
      if (workspace.manager) recipientIds.add(workspace.manager.toString());
    }
  }

  recipientIds.delete(req.user._id.toString());

  const mentions = [...new Set(String(content).match(/@([A-Za-z0-9._-]+)/g) || [])]
    .map((mention) => mention.slice(1).toLowerCase());
  const mentionUsers = mentions.length
    ? await User.find({ tenantId: req.user.tenantId, $or: [
      { firstName: { $in: mentions } },
      { lastName: { $in: mentions } },
      { email: { $in: mentions.map((value) => `${value}@`) } },
    ] })
    : [];

  mentionUsers.forEach((user) => recipientIds.add(user._id.toString()));

  const actionUrl = kind === 'document' ? `/documents?view=${document._id}` : '/documents';

  await Promise.all([...recipientIds].map((userId) => createNotification({
    tenantId: req.user.tenantId,
    user: userId,
    type: mentions.length ? 'mention' : 'workspace_comment',
    title: mentions.length ? 'You were mentioned' : 'New comment added',
    message: mentions.length
      ? `${req.user.firstName} mentioned you in ${targetName}`
      : `${req.user.firstName} commented on ${targetName}`,
    relatedDocument: document?._id,
    relatedAudio: audio?._id,
    relatedWorkspace: workspace?._id,
    actionUrl,
  })));

  // Send notification email to owner when useful; workspace notifications are handled in-app.
  if (kind === 'document' && document.uploadedBy && document.uploadedBy._id.toString() !== req.user._id.toString()) {
    await sendCommentNotificationEmail(document.uploadedBy, document, comment, req.user);
  }

  // Log activity
  await log(req, 'comment_add', 'comment', comment._id, { documentId: document?._id, videoId: video?._id, audioId: audio?._id });

  emitTenantEvent(req.user.tenantId, 'comment:changed', {
    action: 'created',
    commentId: comment._id,
    resourceType: kind,
    resourceId: targetId,
  });

  res.status(201).json({
    status: 'success',
    data: {
      comment,
    },
  });
});

/**
 * Get comments for a document, video, or audio clip
 */
exports.getComments = catchAsync(async (req, res, next) => {
  const { page = 1, limit = 20 } = req.query;
  const { kind, targetId } = resolveCommentTarget(req.params);

  if (kind === 'video') {
    const video = await Video.findOne({
      _id: targetId,
      tenantId: req.user.tenantId,
      isDeleted: false,
      uploadStatus: 'complete',
    });

    if (!video) {
      return next(new AppError('Video not found', 404));
    }

    // Video conversations are tenant-collaborative: any authenticated user
    // in the same tenant may view and participate in the thread.
  } else if (kind === 'audio') {
    const audio = await Audio.findOne({
      _id: targetId,
      tenantId: req.user.tenantId,
      isDeleted: false,
    });

    if (!audio) {
      return next(new AppError('Audio clip not found', 404));
    }

    const canView = audio.hasAccess(req.user._id, 'view') || await canViewWorkspaceDocument(req, audio);
    if (!canView) {
      return next(new AppError('You do not have permission to view comments on this audio clip', 403));
    }
  } else {
    // Check if document exists and user has access
    const document = await Document.findOne({
      _id: targetId,
      tenantId: req.user.tenantId,
      isDeleted: false,
    });

    if (!document) {
      return next(new AppError('Document not found', 404));
    }

    // Check permissions
    const canView = document.canUserAccess(req.user._id, 'view') || await canViewWorkspaceDocument(req, document);
    if (!canView) {
      return next(new AppError('You do not have permission to view comments on this document', 403));
    }
  }

  const comments = await Comment.find({
    [kind]: targetId,
    tenantId: req.user.tenantId,
  })
    .populate('author', 'firstName lastName email')
    .sort('-createdAt')
    .limit(limit * 1)
    .skip((page - 1) * limit);

  // Get total count
  const total = await Comment.countDocuments({
    [kind]: targetId,
    tenantId: req.user.tenantId,
  });

  const threadedComments = buildThreadTree(comments);

  res.status(200).json({
    status: 'success',
    results: threadedComments.length,
    total,
    page: parseInt(page),
    pages: Math.ceil(total / limit),
    data: {
      comments: threadedComments,
    },
  });
});

/**
 * Update comment
 */
exports.updateComment = catchAsync(async (req, res, next) => {
  const { content } = req.body;
  const { commentId } = req.params;

  const comment = await Comment.findOne({
    _id: commentId,
    tenantId: req.user.tenantId,
  });

  if (!comment) {
    return next(new AppError('Comment not found', 404));
  }

  // Only author can update comment
  if (comment.author.toString() !== req.user._id.toString()) {
    return next(new AppError('You can only edit your own comments', 403));
  }

  comment.text = content;
  comment.edited = true;
  comment.editedAt = new Date();
  await comment.save();

  await comment.populate('author', 'firstName lastName email');

  // Log activity
  await log(req, 'comment_update', 'comment', comment._id);

  const resourceType = comment.video ? 'video' : (comment.audio ? 'audio' : 'document');
  emitTenantEvent(req.user.tenantId, 'comment:changed', {
    action: 'updated',
    commentId: comment._id,
    resourceType,
    resourceId: comment.video || comment.audio || comment.document,
  });

  res.status(200).json({
    status: 'success',
    data: {
      comment,
    },
  });
});

/**
 * Delete comment
 */
exports.deleteComment = catchAsync(async (req, res, next) => {
  const { commentId } = req.params;

  const comment = await Comment.findOne({
    _id: commentId,
    tenantId: req.user.tenantId,
  });

  if (!comment) {
    return next(new AppError('Comment not found', 404));
  }

  // Only author or admin can delete comment
  if (comment.author.toString() !== req.user._id.toString() && !isEnterpriseAdmin(req.user)) {
    return next(new AppError('You can only delete your own comments', 403));
  }

  // Delete comment and its replies
  await Comment.deleteMany({
    $or: [
      { _id: commentId },
      { parentComment: commentId },
    ],
  });

  // Log activity
  await log(req, 'comment_delete', 'comment', comment._id);

  const resourceType = comment.video ? 'video' : (comment.audio ? 'audio' : 'document');
  emitTenantEvent(req.user.tenantId, 'comment:changed', {
    action: 'deleted',
    commentId: comment._id,
    resourceType,
    resourceId: comment.video || comment.audio || comment.document,
  });

  res.status(200).json({
    status: 'success',
    message: 'Comment deleted successfully',
  });
});

/**
 * Add reaction to comment
 */
exports.addReaction = catchAsync(async (req, res, next) => {
  const { type } = req.body;
  const { commentId } = req.params;

  const comment = await Comment.findOne({
    _id: commentId,
    tenantId: req.user.tenantId,
  });

  if (!comment) {
    return next(new AppError('Comment not found', 404));
  }

  // Check if user already reacted
  const existingReaction = comment.reactions.find(
    r => r.user.toString() === req.user._id.toString()
  );

  if (existingReaction) {
    // Update reaction type
    existingReaction.type = type;
  } else {
    // Add new reaction
    comment.reactions.push({
      user: req.user._id,
      type,
    });
  }

  await comment.save();

  res.status(200).json({
    status: 'success',
    data: {
      comment,
    },
  });
});

/**
 * Remove reaction from comment
 */
exports.removeReaction = catchAsync(async (req, res, next) => {
  const { commentId } = req.params;

  const comment = await Comment.findOne({
    _id: commentId,
    tenantId: req.user.tenantId,
  });

  if (!comment) {
    return next(new AppError('Comment not found', 404));
  }

  // Remove user's reaction
  comment.reactions = comment.reactions.filter(
    r => r.user.toString() !== req.user._id.toString()
  );

  await comment.save();

  res.status(200).json({
    status: 'success',
    data: {
      comment,
    },
  });
});
