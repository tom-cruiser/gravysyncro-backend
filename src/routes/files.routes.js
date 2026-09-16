const express = require('express');
const fileController = require('../controllers/fileController');
const { protect } = require('../middleware/auth');
const { requireActiveSubscription } = require('../middleware/subscriptionAccess');
const { uploadPlusFiles, handleMulterError } = require('../middleware/upload');
const { uploadLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// All routes require authentication. Gated the same way as Documents,
// Audio and Video (protect -> requireActiveSubscription) — any user with
// an active account/trial gets the file vault, no separate plan needed.
router.use(protect);
router.use(requireActiveSubscription);

router
  .route('/')
  .get(fileController.listFiles)
  .delete(fileController.bulkDeleteFiles);

router.post('/upload', uploadLimiter, uploadPlusFiles, handleMulterError, fileController.uploadFiles);

router.get('/:id/download', fileController.downloadFile);
router.delete('/:id', fileController.deleteFile);

module.exports = router;
