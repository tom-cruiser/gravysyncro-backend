/**
 * Trial expiry / access-lock job.
 *
 * Runs daily (default: midnight) and locks out any user whose 7-day trial
 * has lapsed without being converted to a paid ("active") or admin-approved
 * subscription. Locking here means flipping two fields — `isSubscriptionActive`
 * to false and `accessLevel` to 'locked' — which `middleware/subscriptionAccess.js`
 * then checks on every protected route.
 *
 * Deliberately narrow match: only users still sitting in accessLevel
 * 'trial' get auto-locked. A user already 'active' or 'admin-approved' is
 * left alone even if their original trialExpiresAt is in the past — that
 * field stops being meaningful once a real subscription or admin grant
 * takes over, and this job should never undo either of those.
 */
const cron = require('node-cron');
const User = require('../models/User');
const logger = require('../utils/logger');

const lockExpiredTrials = async () => {
  const now = new Date();

  const result = await User.updateMany(
    {
      accessLevel: 'trial',
      isSubscriptionActive: true,
      trialExpiresAt: { $lte: now },
    },
    {
      $set: {
        isSubscriptionActive: false,
        accessLevel: 'locked',
      },
    }
  );

  const lockedCount = result.modifiedCount ?? result.nModified ?? 0;
  if (lockedCount > 0) {
    logger.info(`[trial-access-lock] Locked ${lockedCount} user(s) with an expired trial.`);
  }

  return lockedCount;
};

const startTrialAccessLock = () => {
  const schedule = process.env.TRIAL_LOCK_CRON_SCHEDULE || '0 0 * * *';

  if (!cron.validate(schedule)) {
    logger.warn(`[trial-access-lock] Invalid cron schedule: ${schedule}`);
    return null;
  }

  const task = cron.schedule(schedule, () => {
    lockExpiredTrials().catch((error) => {
      logger.error('[trial-access-lock] Job execution failed:', error.message);
    });
  });

  if (process.env.TRIAL_LOCK_CRON_RUN_ON_START === 'true') {
    lockExpiredTrials().catch((error) => {
      logger.error('[trial-access-lock] Initial run failed:', error.message);
    });
  }

  logger.info(`[trial-access-lock] Scheduled with pattern "${schedule}"`);
  return task;
};

module.exports = {
  startTrialAccessLock,
  lockExpiredTrials,
};
