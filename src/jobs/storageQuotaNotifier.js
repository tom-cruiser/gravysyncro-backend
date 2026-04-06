const cron = require('node-cron');
const User = require('../models/User');
const { sendStorageQuotaWarningEmail } = require('../services/emailService');
const { getTenantStorageMap } = require('../utils/tenantStorage');

const GB = 1024 * 1024 * 1024;

const roundToTwo = (value) => Number(value.toFixed(2));

const shouldSendWarning = (user, usagePercent) => {
  if (usagePercent < 80) return false;

  const lastSentAt = user.storageWarningLastSentAt ? new Date(user.storageWarningLastSentAt) : null;
  const lastUsagePercent = Number(user.storageWarningLastUsagePercent || 0);

  const enoughTimePassed = !lastSentAt || (Date.now() - lastSentAt.getTime()) >= 7 * 24 * 60 * 60 * 1000;
  const significantlyHigherUsage = usagePercent >= lastUsagePercent + 5;

  return enoughTimePassed || significantlyHigherUsage;
};

const notifyStorageQuota = async () => {
  const users = await User.find({
    isActive: true,
    'preferences.notifications.email': true,
    email: { $exists: true, $ne: null },
  }).select(
    'tenantId firstName email storageUsed storageLimit storageWarningLastSentAt storageWarningLastUsagePercent preferences'
  );

  const tenantIds = [...new Set(users.map((user) => user.tenantId).filter(Boolean))];
  const tenantStorageMap = await getTenantStorageMap(tenantIds);

  const usersByTenant = users.reduce((map, user) => {
    const tenantUsers = map.get(user.tenantId) || [];
    tenantUsers.push(user);
    map.set(user.tenantId, tenantUsers);
    return map;
  }, new Map());

  for (const [tenantId, tenantUsers] of usersByTenant.entries()) {
    const tenantStorage = tenantStorageMap.get(tenantId);
    if (!tenantStorage) continue;

    const representativeUser = tenantUsers[0];
    const storageLimit = Number(tenantStorage.storageLimit || 0);
    const storageUsed = Number(tenantStorage.storageUsed || 0);

    if (storageLimit <= 0) continue;

    const usagePercent = roundToTwo((storageUsed / storageLimit) * 100);

    if (!shouldSendWarning(representativeUser, usagePercent)) {
      if (usagePercent < 75 && (representativeUser.storageWarningLastSentAt || representativeUser.storageWarningLastUsagePercent)) {
        await User.updateMany(
          { tenantId },
          {
            $set: { storageWarningLastUsagePercent: usagePercent },
            $unset: { storageWarningLastSentAt: 1 },
          }
        );
      }
      continue;
    }

    const usedGb = roundToTwo(storageUsed / GB);
    const totalGb = roundToTwo(storageLimit / GB);
    const remainingGb = roundToTwo(Math.max(storageLimit - storageUsed, 0) / GB);

    try {
      await Promise.all(
        tenantUsers.map((user) => sendStorageQuotaWarningEmail(user, {
          usagePercent,
          usedGb,
          totalGb,
          remainingGb,
        }))
      );

      await User.updateMany(
        { tenantId },
        {
          $set: {
            storageWarningLastSentAt: new Date(),
            storageWarningLastUsagePercent: usagePercent,
          },
        }
      );
    } catch (error) {
      console.error(
        `[storage-quota-notifier] Failed to send warning to tenant ${tenantId}:`,
        error.message
      );
    }
  }
};

const startStorageQuotaNotifier = () => {
  const schedule = process.env.STORAGE_QUOTA_CRON_SCHEDULE || '0 9 * * *';

  if (!cron.validate(schedule)) {
    console.warn(`[storage-quota-notifier] Invalid cron schedule: ${schedule}`);
    return null;
  }

  const task = cron.schedule(schedule, async () => {
    try {
      await notifyStorageQuota();
    } catch (error) {
      console.error('[storage-quota-notifier] Job execution failed:', error.message);
    }
  });

  if (process.env.STORAGE_QUOTA_CRON_RUN_ON_START === 'true') {
    notifyStorageQuota().catch((error) => {
      console.error('[storage-quota-notifier] Initial run failed:', error.message);
    });
  }

  console.log(`[storage-quota-notifier] Scheduled with pattern "${schedule}"`);
  return task;
};

module.exports = {
  startStorageQuotaNotifier,
  notifyStorageQuota,
};
