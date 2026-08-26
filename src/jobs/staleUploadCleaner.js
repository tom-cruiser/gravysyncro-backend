/**
 * Stale video upload cleaner
 * Aborts and marks any multipart upload stuck in pending/uploading for >24 h.
 * Also sweeps orphaned document temp files (see below).
 * Run once on server start, then every 6 hours.
 */
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Video = require('../models/Video');
const { abortMultipartUpload } = require('../config/wasabi');
const logger = require('../utils/logger');

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 h

// Document uploads are streamed to this temp dir by multer (see
// middleware/upload.js) and normally deleted by documentController right
// after the request finishes. If a request is aborted mid-upload (dropped
// connection, a size-limit rejection, a server restart mid-transfer) that
// cleanup never runs, so sweep anything left behind for more than an hour —
// well past how long even a 700MB upload should take.
const DOCUMENT_TMP_DIR = path.join(os.tmpdir(), 'gravysyncro-doc-uploads');
const ORPHANED_TMP_FILE_THRESHOLD_MS = 60 * 60 * 1000; // 1 h

const cleanOrphanedTempFiles = async () => {
  try {
    const entries = await fs.promises.readdir(DOCUMENT_TMP_DIR, { withFileTypes: true }).catch(() => []);
    const cutoff = Date.now() - ORPHANED_TMP_FILE_THRESHOLD_MS;

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = path.join(DOCUMENT_TMP_DIR, entry.name);
      try {
        const stats = await fs.promises.stat(filePath);
        if (stats.mtimeMs < cutoff) {
          await fs.promises.unlink(filePath);
          logger.info(`[staleUploadCleaner] Removed orphaned upload temp file: ${entry.name}`);
        }
      } catch {
        // Already removed by the request handler in the meantime — ignore
      }
    }
  } catch (err) {
    logger.error('[staleUploadCleaner] Error sweeping temp upload dir:', err.message);
  }
};

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
  cleanOrphanedTempFiles();
  // Then every 6 hours
  cron.schedule('0 */6 * * *', cleanStaleUploads);
  cron.schedule('0 */6 * * *', cleanOrphanedTempFiles);
  logger.info('[staleUploadCleaner] Scheduled stale upload cleanup every 6 hours.');
};

module.exports = { startStaleUploadCleaner, cleanStaleUploads, cleanOrphanedTempFiles };
