const express = require('express');
const videoController = require('../controllers/videoController');
const { protect, restrictTo } = require('../middleware/auth');
const { uploadLimiter } = require('../middleware/rateLimiter');
const { validate } = require('../middleware/validator');

const router = express.Router();

// All routes require authentication
router.use(protect);

// ── Initiate a new resumable multipart upload ──────────────────────────────
router.post('/initiate', uploadLimiter, validate('initiateVideo'), videoController.initiateUpload);

// ── Active-uploads overview ────────────────────────────────────────────────
router.get('/active-uploads', videoController.getActiveUploads);

// ── List all completed videos ──────────────────────────────────────────────
router.get('/', videoController.getAllVideos);

// ── Per-video routes ───────────────────────────────────────────────────────
router.get('/:id', videoController.getVideo);
router.delete('/:id', videoController.deleteVideo);
router.delete('/:id/permanent', restrictTo('admin'), videoController.permanentDeleteVideo);

// Multipart upload helpers
router.get('/:id/part-url', videoController.getPartUrl);       // get signed PUT URL for one part
router.get('/:id/parts', videoController.getUploadedParts);    // resume: list completed parts
router.post('/:id/complete', videoController.completeUpload);  // finalise multipart upload
router.post('/:id/abort', videoController.abortUpload);        // cancel / cleanup

// Download
router.get('/:id/download', videoController.downloadVideo);

module.exports = router;
