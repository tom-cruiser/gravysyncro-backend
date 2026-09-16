const fs = require('fs');
const path = require('path');
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

  const files = await File.insertMany(
    req.files.map((file) => ({
      userId: req.user._id,
      storedPath: file.path,
      originalName: file.originalname,
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
        mimeType: file.mimeType,
        size: file.size,
        uploadedAt: file.uploadedAt,
      })),
    },
  });
});

/**
 * List the authenticated user's files, newest first.
 */
exports.listFiles = catchAsync(async (req, res, next) => {
  const files = await File.find({ userId: req.user._id })
    .sort({ uploadedAt: -1 })
    .select('originalName size mimeType uploadedAt');

  res.status(200).json({
    status: 'success',
    results: files.length,
    data: {
      files: files.map((file) => ({
        id: file._id,
        originalName: file.originalName,
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
