const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const AppError = require('../utils/appError');

// Documents can now be up to 700MB each — buffering that fully in memory
// (the old behavior) risked exhausting the process's RAM under load,
// especially with several uploads in flight at once. Instead, stream
// documents straight to a temp file on disk as they're received; the
// controller then streams that file on to Wasabi and deletes it afterward
// (see documentController.uploadDocument).
const documentTmpDir = path.join(os.tmpdir(), 'gravysyncro-doc-uploads');
fs.mkdirSync(documentTmpDir, { recursive: true });

const documentDiskStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, documentTmpDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '');
    cb(null, `${Date.now()}-${crypto.randomUUID()}${ext}`);
  },
});

// Audio clips stay well within the 150MB cap, so buffering them in memory
// (as before) is still fine — no need to pay the extra disk I/O for those.
const memoryStorage = multer.memoryStorage();

// File filter
const fileFilter = (req, file, cb) => {
  // Allowed file types
  const allowedTypes = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'text/plain',
    'application/zip',
    'application/x-rar-compressed',
  ];

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new AppError(`File type ${file.mimetype} is not supported`, 400), false);
  }
};

// Multer upload configuration
const upload = multer({
  storage: documentDiskStorage,
  fileFilter: fileFilter,
  limits: {
    fileSize: parseInt(process.env.MAX_DOCUMENT_FILE_SIZE) || 734003200, // 700MB default
    files: parseInt(process.env.MAX_FILES_PER_UPLOAD) || 15000,
  },
});

// Export upload middleware
exports.upload = upload;
exports.uploadSingle = upload.single('file');
exports.uploadMultiple = upload.array('files', parseInt(process.env.MAX_FILES_PER_UPLOAD) || 15000);

// Separate multer instance for audio clips (voice memos, meeting recordings,
// uploaded audio files) — the main `upload` above only allows document/image
// mime types, so audio needs its own filter rather than reusing it.
const audioFileFilter = (req, file, cb) => {
  const allowedAudioTypes = [
    'audio/webm',
    'audio/ogg',
    'audio/mpeg',
    'audio/mp3',
    'audio/mp4',
    'audio/x-m4a',
    'audio/aac',
    'audio/wav',
    'audio/x-wav',
    'audio/flac',
  ];

  if (allowedAudioTypes.includes(file.mimetype) || file.mimetype.startsWith('audio/')) {
    cb(null, true);
  } else {
    cb(new AppError(`File type ${file.mimetype} is not a supported audio format`, 400), false);
  }
};

const audioUpload = multer({
  storage: memoryStorage,
  fileFilter: audioFileFilter,
  limits: {
    // Decoupled from MAX_DOCUMENT_FILE_SIZE on purpose — audio keeps its own cap
    // so changing the document limit never affects the audio upload limit.
    fileSize: parseInt(process.env.MAX_AUDIO_FILE_SIZE) || 157286400, // 150MB default
    files: 1,
  },
});

exports.uploadAudioSingle = audioUpload.single('file');

// Error handler for multer errors
exports.handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new AppError('File size is too large for this upload type.', 400));
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return next(new AppError(`Too many files. Maximum is ${process.env.MAX_FILES_PER_UPLOAD || 15000} files.`, 400));
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return next(new AppError('Unexpected field in form data.', 400));
    }
    return next(new AppError(err.message, 400));
  }
  next(err);
};
