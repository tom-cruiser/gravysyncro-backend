const User = require('../models/User');
const { gbToBytes } = require('./storagePlans');

const DEFAULT_STORAGE_GB = 50;

const toNumber = (value) => Number(value || 0);

const getTenantStorageSummary = async (tenantId) => {
  const users = await User.find({ tenantId }).select(
    'storageUsed storageLimit storagePlanGb storageWarningLastSentAt storageWarningLastUsagePercent '
    + 'billingCycle subscriptionStatus currentPeriodStart currentPeriodEnd'
  );

  const storageUsed = users.reduce((total, user) => total + toNumber(user.storageUsed), 0);
  const storageLimit = users.find((user) => toNumber(user.storageLimit) > 0)?.storageLimit
    || gbToBytes(DEFAULT_STORAGE_GB);
  const storagePlanGb = users.find((user) => Number(user.storagePlanGb || 0) > 0)?.storagePlanGb
    || DEFAULT_STORAGE_GB;
  // Billing/period fields are assigned tenant-wide (see applyTenantStoragePlan),
  // so any user carrying a non-default value represents the whole tenant.
  const representative = users.find((user) => user.billingCycle === 'yearly') || users[0];

  return {
    storageUsed,
    storageLimit,
    storagePlanGb,
    storageRemaining: Math.max(toNumber(storageLimit) - storageUsed, 0),
    storageUsedPercentage: toNumber(storageLimit) > 0
      ? Number(((storageUsed / toNumber(storageLimit)) * 100).toFixed(2))
      : 0,
    billingCycle: representative?.billingCycle || 'monthly',
    subscriptionStatus: representative?.subscriptionStatus || 'active',
    currentPeriodStart: representative?.currentPeriodStart || null,
    currentPeriodEnd: representative?.currentPeriodEnd || null,
    users,
  };
};

const getTenantStorageMap = async (tenantIds = []) => {
  const uniqueTenantIds = [...new Set(tenantIds.filter(Boolean))];
  if (uniqueTenantIds.length === 0) return new Map();

  const users = await User.find({ tenantId: { $in: uniqueTenantIds } }).select(
    'tenantId storageUsed storageLimit storagePlanGb billingCycle subscriptionStatus currentPeriodStart currentPeriodEnd'
  );

  const summaryMap = new Map();

  for (const user of users) {
    const tenantId = user.tenantId;
    const existing = summaryMap.get(tenantId) || {
      storageUsed: 0,
      storageLimit: 0,
      storagePlanGb: DEFAULT_STORAGE_GB,
      billingCycle: 'monthly',
      subscriptionStatus: 'active',
      currentPeriodStart: null,
      currentPeriodEnd: null,
    };

    existing.storageUsed += toNumber(user.storageUsed);
    if (!existing.storageLimit && toNumber(user.storageLimit) > 0) {
      existing.storageLimit = toNumber(user.storageLimit);
    }
    if (Number(user.storagePlanGb || 0) > 0) {
      existing.storagePlanGb = Number(user.storagePlanGb);
    }
    // Billing/period fields are assigned tenant-wide (see
    // applyTenantStoragePlan) — once one user in the tenant shows 'yearly'
    // that's the whole tenant's plan, so let it win over stale monthly data.
    if (user.billingCycle === 'yearly' || !existing.currentPeriodEnd) {
      existing.billingCycle = user.billingCycle || 'monthly';
      existing.subscriptionStatus = user.subscriptionStatus || 'active';
      existing.currentPeriodStart = user.currentPeriodStart || existing.currentPeriodStart;
      existing.currentPeriodEnd = user.currentPeriodEnd || existing.currentPeriodEnd;
    }

    summaryMap.set(tenantId, existing);
  }

  for (const [tenantId, summary] of summaryMap.entries()) {
    const storageLimit = summary.storageLimit || gbToBytes(DEFAULT_STORAGE_GB);
    summary.storageLimit = storageLimit;
    summary.storageRemaining = Math.max(storageLimit - summary.storageUsed, 0);
    summary.storageUsedPercentage = storageLimit > 0
      ? Number(((summary.storageUsed / storageLimit) * 100).toFixed(2))
      : 0;
    summaryMap.set(tenantId, summary);
  }

  return summaryMap;
};

// `extraFields` lets callers set billing-cycle/subscription-period fields
// alongside the plan itself (see adminController.updateEnterpriseStorage for
// the annual-plan case). Plan changes also restore access by default, because
// the paid-feature gate checks `isSubscriptionActive` on the user record.
const applyTenantStoragePlan = async (tenantId, storagePlanGb, extraFields = {}) => {
  const normalizedPlan = Number(storagePlanGb);
  const storageLimit = gbToBytes(normalizedPlan);

  const accessFields = {
    isSubscriptionActive: true,
    accessLevel: 'active',
    trialExpiresAt: null,
    ...extraFields,
  };

  await User.updateMany(
    { tenantId },
    {
      $set: {
        storagePlanGb: normalizedPlan,
        storageLimit,
        ...accessFields,
      },
    }
  );

  return storageLimit;
};

module.exports = {
  DEFAULT_STORAGE_GB,
  getTenantStorageSummary,
  getTenantStorageMap,
  applyTenantStoragePlan,
};