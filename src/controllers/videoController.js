const crypto = require('crypto');
const Video = require('../models/Video');
const User = require('../models/User');
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const { log } = require('../middleware/activityLogger');
const {
  createMultipartUpload,
  getUploadPartSignedUrl,
  completeMultipartUpload,
  abortMultipartUpload,
  listParts,
  deleteFile,
  getSignedUrl,
} = require('../config/wasabi');

// ─── Constants ────────────────────────────────────────────────────────────────
const MAX_VIDEO_SIZE = 1.5 * 1024 * 1024 * 1024;   // 1.5 GB
const MAX_CONCURRENT_UPLOADS = 3;                    // per user
const PART_SIZE = 10 * 1024 * 1024;                  // 10 MB parts

const ALLOWED_MIME_TYPES = new Set([
  'video/mp4',
  'video/quicktime',      // MOV
  'video/x-msvideo',      // AVI
  'video/x-matroska',     // MKV
  'video/webm',
  'video/3gpp',
  'video/3gpp2',
  'video/mpeg',
]);

const ALLOWED_EXTENSIONS = new Set([
  'mp4', 'mov', 'avi', 'mkv', 'webm', '3gp', '3g2', 'mpeg', 'mpg',
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────
const validateVideoFile = (mimeType, fileName, fileSize) => {
  const ext = (fileName || '').split('.').pop().toLowerCase();

  if (!ALLOWED_MIME_TYPES.has(mimeType) && !ALLOWED_EXTENSIONS.has(ext)) {
    throw new AppError(
      `File type not allowed. Accepted formats: MP4, MOV, AVI, MKV, WebM, 3GP, MPEG.`,
      400,
    );
  }
  // Double-check: MIME must start with video/ at minimum
  if (!mimeType.startsWith('video/')) {
    throw new AppError('Invalid MIME type. Only video files are accepted.', 400);
  }
  if (fileSize > MAX_VIDEO_SIZE) {
    throw new AppError('File exceeds maximum allowed size of 1.5 GB.', 400);
  }
};

const countActiveUploads = (userId) =>
  Video.countDocuments({
    uploadedBy: userId,
    uploadStatus: { $in: ['pending', 'uploading'] },
    isDeleted: false,
  });

// ─── Initiate upload ──────────────────────────────────────────────────────────
/**
 * POST /api/v1/videos/initiate
 * Body: { fileName, mimeType, fileSize, title, description, category, tags, folderId, folderPath }
 * Returns: { videoId, uploadId, storageKey, partSize, totalParts }
 */
exports.initiateUpload = catchAsync(async (req, res, next) => {
  const {
    fileName,
    mimeType,
    fileSize,
    title,
    description = '',
    category = 'General',
    tags = '',
    folderId = null,
    folderPath = '',
  } = req.body;

  if (!fileName || !mimeType || !fileSize) {
    return next(new AppError('fileName, mimeType, and fileSize are required.', 400));
  }

  const fileSizeNum = Number(fileSize);
  validateVideoFile(mimeType, fileName, fileSizeNum);

  // Enforce concurrent-upload cap
  const activeCount = await countActiveUploads(req.user._id);
  if (activeCount >= MAX_CONCURRENT_UPLOADS) {
    return next(
      new AppError(
        `You have ${activeCount} upload(s) in progress. Maximum concurrent uploads per user is ${MAX_CONCURRENT_UPLOADS}.`,
        429,
      ),
    );
  }

  // Check storage quota
  const latestUser = await User.findById(req.user._id).select('storageUsed storageLimit');
  if (!latestUser) return next(new AppError('User not found.', 404));

  const projectedUsage = Number(latestUser.storageUsed || 0) + fileSizeNum;
  if (projectedUsage > Number(latestUser.storageLimit || 0)) {
    const available = Math.max(Number(latestUser.storageLimit || 0) - Number(latestUser.storageUsed || 0), 0);
    return next(
      new AppError(
        `Storage limit reached. Available: ${(available / (1024 * 1024)).toFixed(2)} MB.`,
        403,
      ),
    );
  }

  const ext = fileName.split('.').pop().toLowerCase();
  const storageKey = `${req.user.tenantId}/videos/${Date.now()}-${fileName.replace(/\s+/g, '_')}`;

  // Create S3 multipart upload
  const multipart = await createMultipartUpload(storageKey, mimeType, {
    originalName: fileName,
    uploadedBy: req.user._id.toString(),
  });

  const totalParts = Math.ceil(fileSizeNum / PART_SIZE);

  // Persist video record
  const video = await Video.create({
    tenantId: req.user.tenantId,
    owner: req.user._id,
    uploadedBy: req.user._id,
    title: title || fileName,
    description,
    fileName,
    originalName: fileName,
    mimeType,
    fileSize: fileSizeNum,
    fileExtension: ext,
    storageKey,
    uploadId: multipart.UploadId,
    uploadStatus: 'pending',
    uploadedParts: [],
    folderId,
    folderPath: (folderPath || '').replace(/\\/g, '/').split('/').filter(Boolean).join('/'),
    category,
    tags: tags ? String(tags).split(',').map(t => t.trim()).filter(Boolean) : [],
  });

  res.status(201).json({
    status: 'success',
    data: {
      videoId: video._id,
      uploadId: multipart.UploadId,
      storageKey,
      partSize: PART_SIZE,
      totalParts,
    },
  });
});

// ─── Get signed URL for a part ────────────────────────────────────────────────
/**
 * GET /api/v1/videos/:id/part-url?partNumber=N
 * Returns a pre-signed PUT URL for uploading one part directly to S3.
 */
exports.getPartUrl = catchAsync(async (req, res, next) => {
  const { partNumber } = req.query;
  const partNum = parseInt(partNumber, 10);

  if (!partNum || partNum < 1 || partNum > 10000) {
    return next(new AppError('Valid partNumber (1–10000) is required.', 400));
  }

  const video = await Video.findOne({
    _id: req.params.id,
    tenantId: req.user.tenantId,
    isDeleted: false,
  });

  if (!video) return next(new AppError('Video upload not found.', 404));
  if (!video.hasAccess(req.user._id, 'edit') && video.uploadedBy.toString() !== req.user._id.toString()) {
    return next(new AppError('Not authorised.', 403));
  }
  if (!video.uploadId) return next(new AppError('Upload already completed or aborted.', 400));

  const url = getUploadPartSignedUrl(video.storageKey, video.uploadId, partNum);

  res.status(200).json({
    status: 'success',
    data: { url, partNumber: partNum },
  });
});

// ─── Resume: get already-uploaded parts ───────────────────────────────────────
/**
 * GET /api/v1/videos/:id/parts
 * Returns parts already uploaded (to support resumable uploads).
 */
exports.getUploadedParts = catchAsync(async (req, res, next) => {
  const video = await Video.findOne({
    _id: req.params.id,
    tenantId: req.user.tenantId,
    isDeleted: false,
  });

  if (!video) return next(new AppError('Video upload not found.', 404));
  if (video.uploadedBy.toString() !== req.user._id.toString()) {
    return next(new AppError('Not authorised.', 403));
  }
  if (!video.uploadId) {
    return res.status(200).json({ status: 'success', data: { parts: [], uploadStatus: video.uploadStatus } });
  }

  let s3Parts = [];
  try {
    const result = await listParts(video.storageKey, video.uploadId);
    s3Parts = (result.Parts || []).map(p => ({ PartNumber: p.PartNumber, ETag: p.ETag }));
  } catch (err) {
    // UploadId may have expired; return what we have in DB
    s3Parts = video.uploadedParts || [];
  }

  res.status(200).json({
    status: 'success',
    data: { parts: s3Parts, uploadStatus: video.uploadStatus },
  });
});

// ─── Complete upload ──────────────────────────────────────────────────────────
/**
 * POST /api/v1/videos/:id/complete
 * Body: { parts: [{ PartNumber, ETag }], checksum }
 */
exports.completeUpload = catchAsync(async (req, res, next) => {
  const { parts, checksum } = req.body;

  if (!parts || !Array.isArray(parts) || parts.length === 0) {
    return next(new AppError('parts array is required.', 400));
  }

  const video = await Video.findOne({
    _id: req.params.id,
    tenantId: req.user.tenantId,
    isDeleted: false,
  });

  if (!video) return next(new AppError('Video upload not found.', 404));
  if (video.uploadedBy.toString() !== req.user._id.toString()) {
    return next(new AppError('Not authorised.', 403));
  }
  if (!video.uploadId) return next(new AppError('Upload already completed or aborted.', 400));

  // Sort parts by PartNumber (S3 requires ascending order)
  const sortedParts = [...parts].sort((a, b) => a.PartNumber - b.PartNumber);

  await completeMultipartUpload(video.storageKey, video.uploadId, sortedParts);

  // Update record
  video.uploadStatus = 'complete';
  video.uploadId = null;          // clear – no longer needed
  video.uploadedParts = sortedParts;
  if (checksum) video.checksum = checksum; // SHA-256 supplied by client
  await video.save();

  // Update user storage
  await User.findByIdAndUpdate(req.user._id, {
    $inc: { storageUsed: video.fileSize },
  });

  await log(req, 'video_upload', 'video', video._id, { videoName: video.title });

  res.status(200).json({
    status: 'success',
    data: { video },
  });
});

// ─── Abort upload ─────────────────────────────────────────────────────────────
/**
 * POST /api/v1/videos/:id/abort
 */
exports.abortUpload = catchAsync(async (req, res, next) => {
  const video = await Video.findOne({
    _id: req.params.id,
    tenantId: req.user.tenantId,
    isDeleted: false,
  });

  if (!video) return next(new AppError('Video upload not found.', 404));
  if (video.uploadedBy.toString() !== req.user._id.toString()) {
    return next(new AppError('Not authorised.', 403));
  }

  if (video.uploadId) {
    try {
      await abortMultipartUpload(video.storageKey, video.uploadId);
    } catch (err) {
      // Ignore – may have already been cleaned up
    }
  }

  video.uploadStatus = 'aborted';
  video.uploadId = null;
  video.isDeleted = true;
  video.deletedAt = Date.now();
  video.deletedBy = req.user._id;
  await video.save();

  res.status(200).json({ status: 'success', message: 'Upload aborted.' });
});

// ─── List videos ──────────────────────────────────────────────────────────────
exports.getAllVideos = catchAsync(async (req, res, next) => {
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
    uploadStatus: 'complete',
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

  if (req.user.role !== 'admin') {
    query.$or = [
      ...(query.$or || []),
      { uploadedBy: req.user._id },
      { 'sharedWith.user': req.user._id },
    ];
    if (!search && !query.$or.some(c => c.uploadedBy)) {
      query.$or = [
        { uploadedBy: req.user._id },
        { owner: req.user._id },
        { 'sharedWith.user': req.user._id },
      ];
    }
  }

  const videos = await Video.find(query)
    .populate('uploadedBy', 'firstName lastName email')
    .sort(sortBy)
    .limit(Number(limit))
    .skip((Number(page) - 1) * Number(limit));

  const total = await Video.countDocuments(query);

  res.status(200).json({
    status: 'success',
    results: videos.length,
    total,
    page: parseInt(page),
    pages: Math.ceil(total / limit),
    data: { videos },
  });
});

// ─── Get single video (stream via signed URL) ─────────────────────────────────
exports.getVideo = catchAsync(async (req, res, next) => {
  const video = await Video.findOne({
    _id: req.params.id,
    tenantId: req.user.tenantId,
    isDeleted: false,
  });

  if (!video) return next(new AppError('Video not found.', 404));
  if (!video.hasAccess(req.user._id, 'view')) {
    return next(new AppError('Not authorised to view this video.', 403));
  }

  const url = getSignedUrl(video.storageKey, { expiresIn: 7200, disposition: 'inline' });

  video.accessCount = (video.accessCount || 0) + 1;
  video.lastAccessedAt = new Date();
  await video.save();

  await log(req, 'video_view', 'video', video._id, { videoName: video.title });

  res.status(200).json({
    status: 'success',
    data: { video, streamUrl: url },
  });
});

// ─── Download video ───────────────────────────────────────────────────────────
exports.downloadVideo = catchAsync(async (req, res, next) => {
  const video = await Video.findOne({
    _id: req.params.id,
    tenantId: req.user.tenantId,
    isDeleted: false,
    uploadStatus: 'complete',
  });

  if (!video) return next(new AppError('Video not found.', 404));
  if (!video.hasAccess(req.user._id, 'view')) {
    return next(new AppError('Not authorised.', 403));
  }

  const url = getSignedUrl(video.storageKey, {
    expiresIn: 3600,
    downloadName: video.fileName,
    disposition: 'attachment',
  });

  video.downloadCount = (video.downloadCount || 0) + 1;
  await video.save();

  await log(req, 'video_download', 'video', video._id, { videoName: video.title });

  res.status(200).json({ status: 'success', data: { url } });
});

// ─── Soft delete ──────────────────────────────────────────────────────────────
exports.deleteVideo = catchAsync(async (req, res, next) => {
  const video = await Video.findOne({
    _id: req.params.id,
    tenantId: req.user.tenantId,
    isDeleted: false,
  });

  if (!video) return next(new AppError('Video not found.', 404));
  if (!video.hasAccess(req.user._id, 'edit')) {
    return next(new AppError('Not authorised.', 403));
  }

  video.isDeleted = true;
  video.deletedAt = Date.now();
  video.deletedBy = req.user._id;
  video.status = 'deleted';
  await video.save();

  await log(req, 'video_delete', 'video', video._id, { videoName: video.title });

  res.status(200).json({ status: 'success', message: 'Video deleted.' });
});

// ─── Permanent delete ─────────────────────────────────────────────────────────
exports.permanentDeleteVideo = catchAsync(async (req, res, next) => {
  const video = await Video.findOne({
    _id: req.params.id,
    tenantId: req.user.tenantId,
  });

  if (!video) return next(new AppError('Video not found.', 404));

  if (req.user.role !== 'admin' && video.uploadedBy.toString() !== req.user._id.toString()) {
    return next(new AppError('Only admin or the owner can permanently delete a video.', 403));
  }

  // Abort any in-progress upload first
  if (video.uploadId) {
    try { await abortMultipartUpload(video.storageKey, video.uploadId); } catch (_) {}
  }

  try {
    await deleteFile(video.storageKey);
  } catch (err) {
    if (err.code !== 'NoSuchKey') throw err;
  }

  await Video.deleteOne({ _id: video._id });

  if (video.uploadStatus === 'complete') {
    await User.findByIdAndUpdate(video.owner, {
      $inc: { storageUsed: -Math.max(Number(video.fileSize || 0), 0) },
    });
  }

  await log(req, 'video_permanent_delete', 'video', video._id, { videoName: video.title });

  res.status(200).json({ status: 'success', message: 'Video permanently deleted.' });
});

// ─── Active uploads for user (concurrent-upload status) ───────────────────────
exports.getActiveUploads = catchAsync(async (req, res, next) => {
  const active = await Video.find({
    uploadedBy: req.user._id,
    tenantId: req.user.tenantId,
    uploadStatus: { $in: ['pending', 'uploading'] },
    isDeleted: false,
  }).select('_id title fileName fileSize uploadStatus uploadedParts createdAt');

  res.status(200).json({
    status: 'success',
    data: {
      activeUploads: active,
      count: active.length,
      maxConcurrent: MAX_CONCURRENT_UPLOADS,
    },
  });
});
