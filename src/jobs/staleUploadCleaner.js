/**
 * Stale video upload cleaner
 * Aborts and marks any multipart upload stuck in pending/uploading for >24 h.
 * Run once on server start, then every 6 hours.
 */
const cron = require('node-cron');
const Video = require('../models/Video');
const { abortMultipartUpload } = require('../config/wasabi');
const logger = require('../utils/logger');

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 h

const cleanStaleUploads = async () => {
  try {
    const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
    const stale = await Video.find({
      uploadStatus: { $in: ['pending', 'uploading'] },
      createdAt: { $lt: cutoff },
      isDeleted: false,
    });

    if (!stale.length) return;

    logger.info(`[staleUploadCleaner] Found ${stale.length} stale video upload(s) to clean up.`);

    for (const video of stale) {
      if (video.uploadId) {
        try {
          await abortMultipartUpload(video.storageKey, video.uploadId);
        } catch (err) {
          // Already cleaned up or expired — ignore
        }
      }
      video.uploadStatus = 'aborted';
      video.uploadId = null;
      video.isDeleted = true;
      video.deletedAt = new Date();
      await video.save();
      logger.info(`[staleUploadCleaner] Aborted stale upload: ${video._id} (${video.fileName})`);
    }
  } catch (err) {
    logger.error('[staleUploadCleaner] Error during cleanup:', err.message);
  }
};

const startStaleUploadCleaner = () => {
  // Run immediately on startup
  cleanStaleUploads();
  // Then every 6 hours
  cron.schedule('0 */6 * * *', cleanStaleUploads);
  logger.info('[staleUploadCleaner] Scheduled stale upload cleanup every 6 hours.');
};

module.exports = { startStaleUploadCleaner, cleanStaleUploads };
