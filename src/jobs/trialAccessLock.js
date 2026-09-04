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
 *
 * Every admin also gets a notification per affected tenant (mirrors
 * jobs/enterpriseSubscriptionExpiry.js) so a lock shows up in the bell,
 * not just as a row change in the admin user table — an admin can then use
 * PATCH /admin/users/:userId/subscription-access to reactivate the account.
 */
const cron = require('node-cron');
const User = require('../models/User');
const { createNotification } = require('../controllers/notificationController');
const logger = require('../utils/logger');

const groupByTenant = (users) => {
  const map = new Map();
  for (const user of users) {
    const list = map.get(user.tenantId) || [];
    list.push(user);
    map.set(user.tenantId, list);
  }
  return map;
};

const notifyAdmins = async ({ admins, tenantId, title, message }) => Promise.all(
  admins.map((admin) => createNotification({
    tenantId: admin.tenantId,
    user: admin._id,
    type: 'trial_expired',
    title,
    message,
    priority: 'normal',
  }).catch((error) => {
    logger.error(
      `[trial-access-lock] Failed to notify admin ${admin.email} for tenant ${tenantId}:`,
      error.message
    );
  }))
);

const lockExpiredTrials = async () => {
  const now = new Date();

  // Find first (rather than updateMany blind) so we know exactly who got
  // locked and can group them by tenant for the admin notification below.
  const expiredTrialUsers = await User.find({
    accessLevel: 'trial',
    isSubscriptionActive: true,
    trialExpiresAt: { $lte: now },
  }).select('tenantId firstName lastName email trialExpiresAt');

  if (!expiredTrialUsers.length) return 0;

  const result = await User.updateMany(
    { _id: { $in: expiredTrialUsers.map((user) => user._id) } },
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

    const admins = await User.find({ role: 'Admin' });
    for (const [tenantId, tenantUsers] of groupByTenant(expiredTrialUsers).entries()) {
      const names = tenantUsers.map((user) => `${user.firstName} ${user.lastName} (${user.email})`).join(', ');
      await notifyAdmins({
        admins,
        tenantId,
        title: 'Trial Expired — Access Locked',
        message: `${tenantUsers.length} account${tenantUsers.length > 1 ? 's' : ''} on tenant "${tenantId}" `
          + `had their trial expire and access has been locked: ${names}. `
          + `Reactivate from the admin user panel if this was a mistake or they've since paid.`,
      });
    }
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
