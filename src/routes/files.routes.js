const express = require('express');
const fileController = require('../controllers/fileController');
const { protect } = require('../middleware/auth');
const { requirePlus } = require('../middleware/planAccess');
const { uploadPlusFiles, handleMulterError } = require('../middleware/upload');
const { uploadLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// All routes require authentication and an active Plus plan.
router.use(protect);
router.use(requirePlus);

router
  .route('/')
  .get(fileController.listFiles);

router.post('/upload', uploadLimiter, uploadPlusFiles, handleMulterError, fileController.uploadFiles);

router.get('/:id/download', fileController.downloadFile);
router.delete('/:id', fileController.deleteFile);

module.exports = router;
