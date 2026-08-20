const express = require('express');
const audioController = require('../controllers/audioController');
const { protect, restrictTo } = require('../middleware/auth');
const { uploadAudioSingle } = require('../middleware/upload');
const { uploadLimiter } = require('../middleware/rateLimiter');
const { validate } = require('../middleware/validator');

const router = express.Router();

// All routes require authentication
router.use(protect);

router
  .route('/')
  .get(audioController.getAllAudios)
  .post(uploadLimiter, uploadAudioSingle, validate('uploadAudio'), audioController.uploadAudio);

router.get('/:id', audioController.getAudio);
router.get('/:id/download', audioController.downloadAudio);
router.delete('/:id', audioController.deleteAudio);
router.delete('/:id/permanent', restrictTo('Admin'), audioController.permanentDeleteAudio);

module.exports = router;
