/**
 * Annual enterprise subscription expiry/renewal watcher.
 *
 * Enterprise annual plans (Enterprise 1TB/2TB — see utils/storagePlans.js)
 * are assigned manually by an admin and are not tied to any payment
 * processor, so nothing charges the client automatically when a year is
 * up. This job's only job is to keep `subscriptionStatus` accurate and
 * make sure the admin *notices* the renewal is due, since they're the one
 * who has to reach out with the yearly invoice.
 *
 * Runs daily (default: midnight) and, for every tenant on a 'yearly'
 * billing cycle:
 *   - currentPeriodEnd already reached  -> subscriptionStatus 'expired'
 *     and a high-priority admin notification.
 *   - currentPeriodEnd within the warning window (default 14 days out)
 *     and still 'active' -> subscriptionStatus 'pending_renewal' and a
 *     normal-priority admin notification.
 *
 * Both transitions are one-way per period: once a tenant is
 * 'pending_renewal' or 'expired' it's excluded from the matching query
 * above it, so admins are only notified once per event, not once a day
 * for as long as the client stays unrenewed. Re-assigning the plan (i.e.
 * renewing) via the admin storage panel resets currentPeriodStart/End and
 * subscriptionStatus back to 'active', which naturally re-arms both checks
 * for the next cycle.
 *
 * Billing/period fields are set tenant-wide (see
 * utils/tenantStorage.js#applyTenantStoragePlan), so all of a tenant's
 * users share the same values — grouping by tenantId avoids notifying the
 * admin once per seat.
 */
const cron = require('node-cron');
const User = require('../models/User');
const { createNotification } = require('../controllers/notificationController');
const logger = require('../utils/logger');

const RENEWAL_WARNING_DAYS = Number(process.env.ENTERPRISE_RENEWAL_WARNING_DAYS) || 14;

const groupByTenant = (users) => {
  const map = new Map();
  for (const user of users) {
    const list = map.get(user.tenantId) || [];
    list.push(user);
    map.set(user.tenantId, list);
  }
  return map;
};

const notifyAdmins = async ({ admins, tenantId, type, title, message }) => Promise.all(
  admins.map((admin) => createNotification({
    tenantId: admin.tenantId,
    user: admin._id,
    type,
    title,
    message,
    priority: type === 'subscription_expired' ? 'high' : 'normal',
  }).catch((error) => {
    logger.error(
      `[enterprise-subscription-expiry] Failed to notify admin ${admin.email} for tenant ${tenantId}:`,
      error.message
    );
  }))
);

const checkEnterpriseSubscriptions = async () => {
  const now = new Date();
  const warningThreshold = new Date(now.getTime() + RENEWAL_WARNING_DAYS * 24 * 60 * 60 * 1000);

  const admins = await User.find({ role: 'Admin' });
  let expiredTenants = 0;
  let pendingRenewalTenants = 0;

  // 1. Periods already reached -> expire.
  const expiredUsers = await User.find({
    billingCycle: 'yearly',
    subscriptionStatus: { $in: ['active', 'pending_renewal'] },
    currentPeriodEnd: { $lte: now },
  }).select('tenantId firstName lastName storagePlanGb currentPeriodEnd');

  for (const [tenantId, tenantUsers] of groupByTenant(expiredUsers).entries()) {
    await User.updateMany({ tenantId }, { $set: { subscriptionStatus: 'expired' } });

    const rep = tenantUsers[0];
    await notifyAdmins({
      admins,
      tenantId,
      type: 'subscription_expired',
      title: 'Enterprise Subscription Expired',
      message: `The annual Enterprise ${rep.storagePlanGb} GB plan for tenant "${tenantId}" `
        + `expired on ${new Date(rep.currentPeriodEnd).toDateString()}. Follow up with the `
        + `client for their yearly renewal invoice.`,
    });
    expiredTenants += 1;
  }

  // 2. Periods approaching -> flag as pending renewal (only from 'active',
  // so an already-'pending_renewal' or already-'expired' tenant isn't touched).
  const approachingUsers = await User.find({
    billingCycle: 'yearly',
    subscriptionStatus: 'active',
    currentPeriodEnd: { $gt: now, $lte: warningThreshold },
  }).select('tenantId firstName lastName storagePlanGb currentPeriodEnd');

  for (const [tenantId, tenantUsers] of groupByTenant(approachingUsers).entries()) {
    await User.updateMany({ tenantId }, { $set: { subscriptionStatus: 'pending_renewal' } });

    const rep = tenantUsers[0];
    await notifyAdmins({
      admins,
      tenantId,
      type: 'subscription_renewal_due',
      title: 'Enterprise Renewal Coming Up',
      message: `The annual Enterprise ${rep.storagePlanGb} GB plan for tenant "${tenantId}" `
        + `renews on ${new Date(rep.currentPeriodEnd).toDateString()}. Prepare the yearly renewal invoice.`,
    });
    pendingRenewalTenants += 1;
  }

  if (expiredTenants || pendingRenewalTenants) {
    logger.info(
      `[enterprise-subscription-expiry] Expired ${expiredTenants} tenant(s), `
      + `flagged ${pendingRenewalTenants} tenant(s) as pending renewal.`
    );
  }

  return { expiredTenants, pendingRenewalTenants };
};

const startEnterpriseSubscriptionExpiry = () => {
  const schedule = process.env.ENTERPRISE_SUBSCRIPTION_CRON_SCHEDULE || '0 0 * * *';

  if (!cron.validate(schedule)) {
    logger.warn(`[enterprise-subscription-expiry] Invalid cron schedule: ${schedule}`);
    return null;
  }

  const task = cron.schedule(schedule, () => {
    checkEnterpriseSubscriptions().catch((error) => {
      logger.error('[enterprise-subscription-expiry] Job execution failed:', error.message);
    });
  });

  if (process.env.ENTERPRISE_SUBSCRIPTION_CRON_RUN_ON_START === 'true') {
    checkEnterpriseSubscriptions().catch((error) => {
      logger.error('[enterprise-subscription-expiry] Initial run failed:', error.message);
    });
  }

  logger.info(`[enterprise-subscription-expiry] Scheduled with pattern "${schedule}"`);
  return task;
};

module.exports = {
  startEnterpriseSubscriptionExpiry,
  checkEnterpriseSubscriptions,
};
