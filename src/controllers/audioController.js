const Audio = require('../models/Audio');
const User = require('../models/User');
const Workspace = require('../models/Workspace');
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const { uploadFile, deleteFile, getSignedUrl } = require('../config/wasabi');
const { emitTenantEvent } = require('../config/socket');
const { log } = require('../middleware/activityLogger');
const { createNotification } = require('./notificationController');
const { sendSlackMessage } = require('../services/slackService');
const { getTenantStorageSummary } = require('../utils/tenantStorage');
const {
  isEnterpriseAdmin,
  canWriteWorkspace,
  canAccessWorkspace,
  canViewWorkspaceDocument,
} = require('../utils/workspaceAccess');

const getWorkspaceParticipantIds = (workspace) => {
  const ids = new Set();
  if (!workspace) return [];
  if (workspace.manager) ids.add(workspace.manager.toString());
  (workspace.members || []).forEach((member) => ids.add(member.user.toString()));
  (workspace.guests || []).forEach((guest) => ids.add(guest.user.toString()));
  return [...ids];
};

const normalizeStorageFileName = (name = 'audio') =>
  String(name)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || `audio-${Date.now()}`;

/**
 * Upload an audio clip — either a live recording (blob from the in-app
 * MediaRecorder) or an existing audio file, both arrive the same way: a
 * single multipart/form-data request, no multipart-upload machinery needed.
 * POST /api/v1/audios
 */
exports.uploadAudio = catchAsync(async (req, res, next) => {
  if (!req.file) {
    return next(new AppError('Please provide an audio file to upload', 400));
  }
  if (!Buffer.isBuffer(req.file.buffer) || req.file.buffer.length === 0) {
    return next(new AppError('Uploaded audio file is empty or invalid. Please try again.', 400));
  }

  const {
    title,
    description = '',
    category = 'General',
    tags = '',
    workspaceId = null,
    folderId = null,
    folderPath = '',
    duration = 0,
    recordedLive = false,
  } = req.body;

  let workspace = null;
  if (workspaceId) {
    workspace = await Workspace.findOne({ _id: workspaceId, tenantId: req.user.tenantId });
    if (!workspace) {
      return next(new AppError('Workspace not found', 404));
    }
    const canUpload = await canWriteWorkspace(req, workspaceId);
    if (!canUpload) {
      return next(new AppError('You do not have access to upload audio to this workspace.', 403));
    }
    if (workspace.status === 'archived' && !workspace.reworkEnabled) {
      return next(new AppError('This workspace is archived and read-only.', 403));
    }
  }

  const [latestUser, tenantStorage] = await Promise.all([
    User.findById(req.user._id).select('storageUsed storageLimit'),
    getTenantStorageSummary(req.user.tenantId),
  ]);
  if (!latestUser) {
    return next(new AppError('User not found', 404));
  }

  const fileSizeBytes = req.file.buffer.length;
  const projectedUsage = Number(tenantStorage.storageUsed || 0) + fileSizeBytes;
  if (projectedUsage > Number(tenantStorage.storageLimit || 0)) {
    const availableBytes = Math.max(Number(tenantStorage.storageLimit || 0) - Number(tenantStorage.storageUsed || 0), 0);
    return next(
      new AppError(
        `Enterprise storage limit reached. Available space: ${(availableBytes / (1024 * 1024)).toFixed(2)} MB. Please ask your admin to upgrade the enterprise plan.`,
        403
      )
    );
  }

  const resolvedOriginalName = String(req.file.originalname || '').trim() || 'recording.webm';
  const ext = resolvedOriginalName.includes('.') ? resolvedOriginalName.split('.').pop().toLowerCase() : 'webm';
  const safeFileName = normalizeStorageFileName(resolvedOriginalName);
  const storageKey = `${req.user.tenantId}/audio/${Date.now()}-${safeFileName}`;

  try {
    await uploadFile(storageKey, req.file.buffer, req.file.mimetype);
  } catch (wasabiError) {
    if (wasabiError.code === 'Forbidden' || wasabiError.code === 'AccessDenied') {
      return next(new AppError('Storage service permission denied. Please verify Wasabi credentials.', 503));
    }
    if (wasabiError.code === 'NoSuchBucket') {
      return next(new AppError('Storage bucket not found. Please verify bucket configuration.', 503));
    }
    throw wasabiError;
  }

  const parsedTags = tags ? String(tags).split(',').map((tag) => tag.trim()).filter(Boolean) : [];
  const normalizedFolderPath = String(folderPath || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .join('/');

  const audio = new Audio({
    tenantId: req.user.tenantId,
    owner: req.user._id,
    uploadedBy: req.user._id,
    workspaceId: workspace ? workspace._id : null,
    title: title || resolvedOriginalName,
    description,
    fileName: resolvedOriginalName,
    originalName: resolvedOriginalName,
    mimeType: req.file.mimetype,
    fileSize: fileSizeBytes,
    fileExtension: ext,
    duration: Number(duration) || 0,
    recordedLive: recordedLive === true || recordedLive === 'true',
    storageKey,
    checksum: `${Date.now()}-${fileSizeBytes}`,
    folderId,
    folderPath: normalizedFolderPath,
    category,
    tags: parsedTags,
  });

  audio.$locals.currentUser = req.user;
  audio.$locals.assetActivity = {
    action: 'UPLOAD',
    previousState: null,
    newState: audio.lifecycleState,
    details: {},
  };

  await audio.save();

  await User.findByIdAndUpdate(req.user._id, {
    $inc: { storageUsed: fileSizeBytes },
  });

  await log(req, 'audio_upload', 'audio', audio._id, { audioName: audio.title });

  if (workspace) {
    const participants = getWorkspaceParticipantIds(workspace).filter((userId) => userId !== req.user._id.toString());
    await Promise.all(participants.map((userId) => createNotification({
      tenantId: req.user.tenantId,
      user: userId,
      type: 'workspace_uploaded',
      title: 'New audio clip uploaded',
      message: `${req.user.firstName} ${req.user.lastName} uploaded an audio clip: "${audio.title}"`,
      relatedAudio: audio._id,
      relatedWorkspace: workspace._id,
      actionUrl: '/documents',
    })));

    emitTenantEvent(req.user.tenantId, 'audio:uploaded', {
      audioId: audio._id,
      workspaceId: workspace._id,
      title: audio.title,
    });
  }

  // Fire-and-forget: never let a Slack hiccup slow down or fail this request.
  sendSlackMessage(
    [
      ':studio_microphone: *New audio clip uploaded*',
      `*By:* ${req.user.firstName} ${req.user.lastName} (${req.user.email})`,
      `*Title:* ${audio.title}`,
      workspace ? `*Workspace:* ${workspace.name}` : null,
      `*Duration:* ${audio.durationFormatted}`,
      `*Source:* ${audio.recordedLive ? 'Recorded in-app' : 'Uploaded file'}`,
    ].filter(Boolean).join('\n')
  );

  res.status(201).json({
    status: 'success',
    data: { audio },
  });
});

/**
 * List audio clips
 * GET /api/v1/audios
 */
exports.getAllAudios = catchAsync(async (req, res, next) => {
  const {
    page = 1,
    limit = 20,
    search,
    category,
    folderId,
    sortBy = '-createdAt',
  } = req.query;

  const query = {
    tenantId: req.user.tenantId,
    isDeleted: false,
  };

  if (search) {
    query.$or = [
      { title: { $regex: search, $options: 'i' } },
      { description: { $regex: search, $options: 'i' } },
    ];
  }
  if (category) query.category = category;
  if (folderId === 'null') query.folderId = null;
  else if (folderId) query.folderId = folderId;
  if (req.query.workspaceId) {
    if (!isEnterpriseAdmin(req.user)) {
      const canView = await canAccessWorkspace(req, req.query.workspaceId);
      if (!canView) {
        return next(new AppError('You do not have access to this workspace.', 403));
      }
    }
    query.workspaceId = req.query.workspaceId;
  }

  const audios = await Audio.find(query)
    .populate('uploadedBy', 'firstName lastName email')
    .sort(sortBy)
    .limit(Number(limit))
    .skip((Number(page) - 1) * Number(limit));

  const total = await Audio.countDocuments(query);

  res.status(200).json({
    status: 'success',
    results: audios.length,
    total,
    page: parseInt(page),
    pages: Math.ceil(total / limit),
    data: { audios },
  });
});

/**
 * Get a single audio clip + a signed streaming URL for inline playback.
 * GET /api/v1/audios/:id
 */
exports.getAudio = catchAsync(async (req, res, next) => {
  const audio = await Audio.findOne({
    _id: req.params.id,
    tenantId: req.user.tenantId,
    isDeleted: false,
  });

  if (!audio) return next(new AppError('Audio clip not found.', 404));

  const canView = audio.hasAccess(req.user._id, 'view') || await canViewWorkspaceDocument(req, audio);
  if (!canView) {
    return next(new AppError('You do not have permission to view this audio clip.', 403));
  }

  const url = getSignedUrl(audio.storageKey, { expiresIn: 7200, disposition: 'inline' });

  audio.accessCount = (audio.accessCount || 0) + 1;
  audio.lastAccessedAt = new Date();
  await audio.save();

  await log(req, 'audio_view', 'audio', audio._id, { audioName: audio.title });

  res.status(200).json({
    status: 'success',
    data: { audio, streamUrl: url },
  });
});

/**
 * Download an audio clip (signed attachment URL).
 * GET /api/v1/audios/:id/download
 */
exports.downloadAudio = catchAsync(async (req, res, next) => {
  const audio = await Audio.findOne({
    _id: req.params.id,
    tenantId: req.user.tenantId,
    isDeleted: false,
  });

  if (!audio) return next(new AppError('Audio clip not found.', 404));

  const canView = audio.hasAccess(req.user._id, 'view') || await canViewWorkspaceDocument(req, audio);
  if (!canView) {
    return next(new AppError('You do not have permission to download this audio clip.', 403));
  }

  const url = getSignedUrl(audio.storageKey, {
    expiresIn: 3600,
    downloadName: audio.fileName,
    disposition: 'attachment',
  });

  audio.downloadCount = (audio.downloadCount || 0) + 1;
  await audio.save();

  await log(req, 'audio_download', 'audio', audio._id, { audioName: audio.title });

  res.status(200).json({ status: 'success', data: { url } });
});

/**
 * Soft delete
 * DELETE /api/v1/audios/:id
 */
exports.deleteAudio = catchAsync(async (req, res, next) => {
  const audio = await Audio.findOne({
    _id: req.params.id,
    tenantId: req.user.tenantId,
    isDeleted: false,
  });

  if (!audio) return next(new AppError('Audio clip not found.', 404));
  if (!audio.hasAccess(req.user._id, 'edit') && !isEnterpriseAdmin(req.user)) {
    return next(new AppError('Not authorised.', 403));
  }

  audio.isDeleted = true;
  audio.deletedAt = Date.now();
  audio.deletedBy = req.user._id;
  audio.$locals.currentUser = req.user;
  await audio.save();

  await log(req, 'audio_delete', 'audio', audio._id, { audioName: audio.title });

  res.status(200).json({ status: 'success', message: 'Audio clip deleted.' });
});

/**
 * Permanent delete (admin only)
 * DELETE /api/v1/audios/:id/permanent
 */
exports.permanentDeleteAudio = catchAsync(async (req, res, next) => {
  const audio = await Audio.findOne({
    _id: req.params.id,
    tenantId: req.user.tenantId,
  });

  if (!audio) return next(new AppError('Audio clip not found.', 404));

  if (!isEnterpriseAdmin(req.user) && audio.uploadedBy.toString() !== req.user._id.toString()) {
    return next(new AppError('Only admin or the owner can permanently delete an audio clip.', 403));
  }

  try {
    await deleteFile(audio.storageKey);
  } catch (err) {
    if (err.code !== 'NoSuchKey') throw err;
  }

  audio.$locals.currentUser = req.user;
  await audio.deleteOne();

  await User.findByIdAndUpdate(audio.owner, {
    $inc: { storageUsed: -Math.max(Number(audio.fileSize || 0), 0) },
  });

  await log(req, 'audio_permanent_delete', 'audio', audio._id, { audioName: audio.title });

  res.status(200).json({ status: 'success', message: 'Audio clip permanently deleted.' });
});
