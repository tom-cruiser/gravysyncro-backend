const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const File = require('../models/File');
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

// Same approach as config/wasabi.js's ResponseContentDisposition handling:
// a plain filename= fallback (control chars/quotes stripped) plus an
// RFC 5987 filename*= for clients that support non-ASCII names.
const sanitizeFileName = (name = 'file') =>
  String(name).replace(/[\r\n]/g, ' ').replace(/["\\]/g, '').trim() || 'file';

const encodeRFC5987ValueChars = (str) =>
  encodeURIComponent(str).replace(/['()]/g, escape).replace(/\*/g, '%2A');

const escapeRegExp = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Upload one or more files (Plus vault). No MIME/extension restriction —
 * multer.diskStorage has already written the raw bytes to
 * uploads/user_{userId}/{uuid}{ext} (see middleware/upload.js uploadPlusFiles)
 * before this handler runs; here we just record the metadata.
 */
exports.uploadFiles = catchAsync(async (req, res, next) => {
  if (!req.files || req.files.length === 0) {
    return next(new AppError('Please provide at least one file to upload', 400));
  }

  // Optional folder-structure metadata from the client (see PlusFiles.jsx):
  // 'relativePaths' is a JSON array aligned by index with the uploaded
  // files (folder drop/select), 'relativePath' a single-file convenience
  // form of the same thing. Purely descriptive — falls back to the
  // filename when absent, and never affects where the file is stored.
  let relativePaths = [];
  if (req.body.relativePaths) {
    try {
      const parsed = JSON.parse(req.body.relativePaths);
      if (Array.isArray(parsed)) relativePaths = parsed;
    } catch (_) {
      // Malformed input — fall through to the per-file default below.
    }
  } else if (req.body.relativePath && req.files.length === 1) {
    relativePaths = [req.body.relativePath];
  }

  const files = await File.insertMany(
    req.files.map((file, index) => ({
      userId: req.user._id,
      storedPath: file.path,
      originalName: file.originalname,
      relativePath: relativePaths[index] || file.originalname,
      mimeType: file.mimetype || 'application/octet-stream',
      size: file.size,
    })),
  );

  res.status(201).json({
    status: 'success',
    data: {
      files: files.map((file) => ({
        id: file._id,
        originalName: file.originalName,
        relativePath: file.relativePath,
        mimeType: file.mimeType,
        size: file.size,
        uploadedAt: file.uploadedAt,
      })),
    },
  });
});

/**
 * List the authenticated user's files, newest first. Optional ?search=
 * filters by originalName/relativePath (case-insensitive substring) so
 * users can find a file or folder without paging through everything.
 */
exports.listFiles = catchAsync(async (req, res, next) => {
  const query = { userId: req.user._id };

  const search = String(req.query.search || '').trim();
  if (search) {
    const pattern = new RegExp(escapeRegExp(search), 'i');
    query.$or = [{ originalName: pattern }, { relativePath: pattern }];
  }

  const files = await File.find(query)
    .sort({ uploadedAt: -1 })
    .select('originalName relativePath size mimeType uploadedAt');

  res.status(200).json({
    status: 'success',
    results: files.length,
    data: {
      files: files.map((file) => ({
        id: file._id,
        originalName: file.originalName,
        relativePath: file.relativePath,
        size: file.size,
        mimeType: file.mimeType,
        uploadedAt: file.uploadedAt,
      })),
    },
  });
});

/**
 * Stream a file back byte-for-byte: no transformation, original MIME type
 * and filename preserved via headers set before piping the read stream.
 */
exports.downloadFile = catchAsync(async (req, res, next) => {
  const file = await File.findOne({ _id: req.params.id, userId: req.user._id });
  if (!file) {
    return next(new AppError('File not found', 404));
  }

  if (!fs.existsSync(file.storedPath)) {
    return next(new AppError('File is missing from storage', 404));
  }

  const safeName = sanitizeFileName(file.originalName);

  // app.js applies gzip/br compression globally; compression rewrites the
  // response (dropping the Content-Length we set below and re-encoding the
  // body) for anything past its size threshold, which would break both the
  // "Content-Length = stored size" and "no transformation of the bytes"
  // guarantees for a plain (non-Accept-Encoding-aware) client. res.locals
  // is the opt-out hook wired up in app.js's compression() filter.
  res.locals.skipCompression = true;
  res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
  res.setHeader('Content-Length', file.size);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${safeName}"; filename*=UTF-8''${encodeRFC5987ValueChars(safeName)}`,
  );

  const stream = fs.createReadStream(file.storedPath);
  stream.on('error', () => next(new AppError('Failed to read file from storage', 500)));
  stream.pipe(res);
});

/**
 * Delete a file: removes both the Mongo document and the file on disk.
 */
exports.deleteFile = catchAsync(async (req, res, next) => {
  const file = await File.findOne({ _id: req.params.id, userId: req.user._id });
  if (!file) {
    return next(new AppError('File not found', 404));
  }

  await File.deleteOne({ _id: file._id });
  fs.unlink(file.storedPath, () => {});

  res.status(200).json({ status: 'success', message: 'File deleted.' });
});

/**
 * Delete many files at once: removes the Mongo documents and, best-effort,
 * their files on disk. Ownership-scoped — an id that isn't the caller's own
 * file (or doesn't exist, or already has no file on disk) is simply
 * skipped rather than failing the whole batch, since that's the normal
 * shape of a bulk cleanup (some entries may already be gone).
 */
exports.bulkDeleteFiles = catchAsync(async (req, res, next) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  if (ids.length === 0) {
    return next(new AppError('Please provide an array of file ids to delete.', 400));
  }
  if (ids.length > 5000) {
    return next(new AppError('Too many ids in one request. Maximum is 5000.', 400));
  }

  const validIds = ids.filter((id) => mongoose.Types.ObjectId.isValid(id));

  const files = await File.find({ _id: { $in: validIds }, userId: req.user._id }).select('_id storedPath');

  if (files.length === 0) {
    return res.status(200).json({ status: 'success', data: { deletedCount: 0, requested: ids.length } });
  }

  await File.deleteMany({ _id: { $in: files.map((file) => file._id) } });
  files.forEach((file) => fs.unlink(file.storedPath, () => {}));

  res.status(200).json({
    status: 'success',
    data: {
      deletedCount: files.length,
      deletedIds: files.map((file) => file._id),
      requested: ids.length,
    },
  });
});
