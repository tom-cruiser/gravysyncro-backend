const ActivityLog = require('../models/ActivityLog');

const logAssetActivity = async ({
  tenantId,
  workspaceId = null,
  userId,
  assetId,
  assetType,
  action,
  previousState = null,
  newState = null,
  timestamp = new Date(),
  details = {},
}) => {
  if (!tenantId || !userId || !assetId || !assetType || !action) {
    return null;
  }

  return ActivityLog.create({
    tenantId,
    workspaceId,
    user: userId,
    userId,
    assetId,
    assetType,
    action,
    previousState,
    newState,
    timestamp,
    resourceType: assetType.toLowerCase(),
    resourceId: assetId,
    details: {
      ...details,
      previousState,
      newState,
    },
  });
};

module.exports = {
  logAssetActivity,
};