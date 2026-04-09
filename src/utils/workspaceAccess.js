const WorkspaceMember = require('../models/WorkspaceMember');

const ROLE_ALIASES = {
  'Enterprise Admin': 'Enterprise Admin',
  Admin: 'Enterprise Admin',
  'Workspace Manager': 'Workspace Manager',
  Manager: 'Workspace Manager',
  Contributor: 'Contributor',
  Member: 'Contributor',
  Guest: 'Guest',
  Client: 'Guest',
};

const normalizeRole = (role) => ROLE_ALIASES[role] || role || 'Guest';

const isEnterpriseAdmin = (user) => normalizeRole(user?.role) === 'Enterprise Admin';

const isWorkspaceManager = (user) => normalizeRole(user?.role) === 'Workspace Manager';

const isContributor = (user) => normalizeRole(user?.role) === 'Contributor';

const isGuest = (user) => normalizeRole(user?.role) === 'Guest';

const syncWorkspaceMembers = async ({ tenantId, workspaceId, managerId, memberIds = [], guestIds = [], invitedBy }) => {
  const memberRole = 'Contributor';
  const guestRole = 'Guest';
  const managerRole = 'Workspace Manager';

  const uniqueMemberIds = [...new Set(memberIds.map(String).filter(Boolean))];
  const uniqueGuestIds = [...new Set(guestIds.map(String).filter(Boolean))];

  const membershipMap = new Map();
  const setMembership = (userId, role) => {
    if (!userId) return;
    const key = String(userId);
    const existing = membershipMap.get(key);
    const priority = { 'Workspace Manager': 3, Contributor: 2, Guest: 1 };
    if (!existing || priority[role] > priority[existing.role]) {
      membershipMap.set(key, {
        tenantId,
        workspace: workspaceId,
        user: key,
        role,
        invitedBy: invitedBy || managerId,
        isActive: true,
      });
    }
  };

  setMembership(managerId, managerRole);
  uniqueMemberIds.forEach((userId) => setMembership(userId, memberRole));
  uniqueGuestIds.forEach((userId) => setMembership(userId, guestRole));

  const documents = [...membershipMap.values()];

  await WorkspaceMember.deleteMany({ tenantId, workspace: workspaceId });
  if (documents.length > 0) {
    await WorkspaceMember.insertMany(documents, { ordered: false });
  }
};

const getAccessibleWorkspaceIds = async (req) => {
  if (isEnterpriseAdmin(req.user)) {
    return null;
  }

  const memberships = await WorkspaceMember.find({
    tenantId: req.user.tenantId,
    user: req.user._id,
    isActive: true,
  }).select('workspace');

  return memberships.map((membership) => membership.workspace.toString());
};

const canAccessWorkspace = async (req, workspaceId) => {
  if (isEnterpriseAdmin(req.user)) {
    return true;
  }

  const membership = await WorkspaceMember.findOne({
    tenantId: req.user.tenantId,
    workspace: workspaceId,
    user: req.user._id,
    isActive: true,
  });

  return !!membership;
};

const canManageWorkspace = (req, workspace) => isEnterpriseAdmin(req.user) || workspace?.manager?.toString() === req.user?._id?.toString();

const canInviteWorkspaceMembers = async (req, workspaceId) => {
  if (isEnterpriseAdmin(req.user)) {
    return true;
  }

  const membership = await WorkspaceMember.findOne({
    tenantId: req.user.tenantId,
    workspace: workspaceId,
    user: req.user._id,
    isActive: true,
  }).lean();

  return !!membership && ['Workspace Manager', 'Contributor'].includes(membership.role);
};

const canWriteWorkspace = async (req, workspaceId) => {
  if (isEnterpriseAdmin(req.user)) {
    return true;
  }

  const membership = await WorkspaceMember.findOne({
    tenantId: req.user.tenantId,
    workspace: workspaceId,
    user: req.user._id,
    isActive: true,
  }).lean();

  return !!membership && ['Workspace Manager', 'Contributor'].includes(membership.role);
};

const canViewWorkspaceDocument = async (req, document) => {
  if (!document?.workspaceId) {
    return true;
  }

  if (isEnterpriseAdmin(req.user)) {
    return true;
  }

  return canAccessWorkspace(req, document.workspaceId);
};

const canMutateWorkspaceDocument = async (req, document) => {
  if (!document?.workspaceId) {
    return true;
  }

  if (isEnterpriseAdmin(req.user)) {
    return true;
  }

  return canWriteWorkspace(req, document.workspaceId);
};

module.exports = {
  normalizeRole,
  isEnterpriseAdmin,
  isWorkspaceManager,
  isContributor,
  isGuest,
  syncWorkspaceMembers,
  getAccessibleWorkspaceIds,
  canAccessWorkspace,
  canManageWorkspace,
  canInviteWorkspaceMembers,
  canWriteWorkspace,
  canViewWorkspaceDocument,
  canMutateWorkspaceDocument,
};