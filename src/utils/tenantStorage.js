const User = require('../models/User');
const { gbToBytes } = require('./storagePlans');

const DEFAULT_STORAGE_GB = 50;

const toNumber = (value) => Number(value || 0);

const getTenantStorageSummary = async (tenantId) => {
  const users = await User.find({ tenantId }).select(
    'storageUsed storageLimit storagePlanGb storageWarningLastSentAt storageWarningLastUsagePercent'
  );

  const storageUsed = users.reduce((total, user) => total + toNumber(user.storageUsed), 0);
  const storageLimit = users.find((user) => toNumber(user.storageLimit) > 0)?.storageLimit
    || gbToBytes(DEFAULT_STORAGE_GB);
  const storagePlanGb = users.find((user) => Number(user.storagePlanGb || 0) > 0)?.storagePlanGb
    || DEFAULT_STORAGE_GB;

  return {
    storageUsed,
    storageLimit,
    storagePlanGb,
    storageRemaining: Math.max(toNumber(storageLimit) - storageUsed, 0),
    storageUsedPercentage: toNumber(storageLimit) > 0
      ? Number(((storageUsed / toNumber(storageLimit)) * 100).toFixed(2))
      : 0,
    users,
  };
};

const getTenantStorageMap = async (tenantIds = []) => {
  const uniqueTenantIds = [...new Set(tenantIds.filter(Boolean))];
  if (uniqueTenantIds.length === 0) return new Map();

  const users = await User.find({ tenantId: { $in: uniqueTenantIds } }).select(
    'tenantId storageUsed storageLimit storagePlanGb'
  );

  const summaryMap = new Map();

  for (const user of users) {
    const tenantId = user.tenantId;
    const existing = summaryMap.get(tenantId) || {
      storageUsed: 0,
      storageLimit: 0,
      storagePlanGb: DEFAULT_STORAGE_GB,
    };

    existing.storageUsed += toNumber(user.storageUsed);
    if (!existing.storageLimit && toNumber(user.storageLimit) > 0) {
      existing.storageLimit = toNumber(user.storageLimit);
    }
    if (Number(user.storagePlanGb || 0) > 0) {
      existing.storagePlanGb = Number(user.storagePlanGb);
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

const applyTenantStoragePlan = async (tenantId, storagePlanGb) => {
  const normalizedPlan = Number(storagePlanGb);
  const storageLimit = gbToBytes(normalizedPlan);

  await User.updateMany(
    { tenantId },
    {
      $set: {
        storagePlanGb: normalizedPlan,
        storageLimit,
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