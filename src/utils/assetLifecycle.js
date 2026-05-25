const { normalizeRole } = require('./workspaceAccess');

const LIFECYCLE_STATES = ['STARTED', 'IN_PROGRESS', 'NEEDS_REVIEW', 'REJECTED', 'FINISHED', 'ARCHIVED'];
const LOCKING_STATES = new Set(['FINISHED', 'ARCHIVED']);
const MUTABLE_WHEN_LOCKED = new Set([
  'accessCount',
  'downloadCount',
  'lastAccessedAt',
  'updatedAt',
  'accessLog',
]);

const isPrivilegedAssetActor = (user) => {
  const role = normalizeRole(user?.role);
  return role === 'Enterprise Admin' || role === 'Workspace Manager';
};

const getLockedMutationPaths = (document) =>
  document.modifiedPaths().filter((path) => !MUTABLE_WHEN_LOCKED.has(path));

const applyLifecycleLock = (document) => {
  if (LOCKING_STATES.has(document.lifecycleState)) {
    document.lifecycleLocked = true;
    if (!document.lockedAt) {
      document.lockedAt = new Date();
    }
  }

  if (!document.lifecycleStateUpdatedAt || document.isModified('lifecycleState')) {
    document.lifecycleStateUpdatedAt = new Date();
  }
};

const buildTenantDateRangeMatch = ({ tenantId, workspaceId = null, startDate, endDate, stateField = null, states = null }) => {
  const match = {
    tenantId,
  };

  if (workspaceId) {
    match.workspaceId = workspaceId;
  }

  if (stateField && states && states.length > 0) {
    match[stateField] = { $in: states };
  }

  if (startDate || endDate) {
    match.lifecycleStateUpdatedAt = {};
    if (startDate) {
      match.lifecycleStateUpdatedAt.$gte = startDate;
    }
    if (endDate) {
      match.lifecycleStateUpdatedAt.$lte = endDate;
    }
  }

  return match;
};

module.exports = {
  LIFECYCLE_STATES,
  LOCKING_STATES,
  MUTABLE_WHEN_LOCKED,
  isPrivilegedAssetActor,
  getLockedMutationPaths,
  applyLifecycleLock,
  buildTenantDateRangeMatch,
};