const Workspace = require('../models/Workspace');
const Tenant = require('../models/Tenant');
const User = require('../models/User');
const WorkspaceMember = require('../models/WorkspaceMember');
const Document = require('../models/Document');
const Notification = require('../models/Notification');
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const { emitTenantEvent } = require('../config/socket');
const { createNotification } = require('./notificationController');
const { sendEmail } = require('../services/emailService');
const crypto = require('crypto');
const {
  isEnterpriseAdmin,
  isWorkspaceManager,
  syncWorkspaceMembers,
  getAccessibleWorkspaceIds,
  canManageWorkspace,
} = require('../utils/workspaceAccess');

const ensureWorkspaceAccess = async (req, workspaceId, next) => {
  const workspace = await Workspace.findOne({ _id: workspaceId, tenantId: req.user.tenantId });
  if (!workspace) {
    next(new AppError('Workspace not found', 404));
    return null;
  }

  const mapping = await WorkspaceMember.findOne({
    tenantId: req.user.tenantId,
    workspace: workspaceId,
    user: req.user._id,
    isActive: true,
  });

  const canAccess = isEnterpriseAdmin(req.user) || !!mapping;

  if (!canAccess) {
    next(new AppError('You do not have access to this workspace', 403));
    return null;
  }

  return workspace;
};

exports.getWorkspaces = catchAsync(async (req, res) => {
  const accessibleWorkspaceIds = await getAccessibleWorkspaceIds(req);
  const query = isEnterpriseAdmin(req.user)
    ? { tenantId: req.user.tenantId }
    : { tenantId: req.user.tenantId, _id: { $in: accessibleWorkspaceIds || [] } };

  const workspaces = await Workspace.find(query)
    .populate('manager', 'firstName lastName email role')
    .populate('members.user', 'firstName lastName email role')
    .populate('guests.user', 'firstName lastName email role')
    .sort('-createdAt');

  res.status(200).json({ status: 'success', data: { workspaces } });
});

exports.createWorkspace = catchAsync(async (req, res, next) => {
  const { name, description, clientName, memberIds = [], guestIds = [] } = req.body;
  const sanitizedMemberIds = [...new Set(memberIds.map(String).filter(Boolean))];
  const sanitizedGuestIds = [...new Set(guestIds.map(String).filter(Boolean))];
  const allowedUserIds = [...sanitizedMemberIds, ...sanitizedGuestIds];

  const invitedUsers = allowedUserIds.length
    ? await User.find({ tenantId: req.user.tenantId, _id: { $in: allowedUserIds } })
    : [];

  const invitedMap = new Map(invitedUsers.map((user) => [user._id.toString(), user]));

  const members = sanitizedMemberIds
    .filter((userId) => invitedMap.has(userId))
    .map((userId) => ({ user: userId, permission: 'member', invitedBy: req.user._id }));

  const guests = sanitizedGuestIds
    .filter((userId) => invitedMap.has(userId))
    .map((userId) => ({ user: userId, permission: 'guest', invitedBy: req.user._id }));

  const workspace = await Workspace.create({
    tenantId: req.user.tenantId,
    name,
    description,
    clientName,
    createdBy: req.user._id,
    manager: req.user._id,
    members,
    guests,
  });

  await syncWorkspaceMembers({
    tenantId: req.user.tenantId,
    workspaceId: workspace._id,
    managerId: req.user._id,
    memberIds: sanitizedMemberIds,
    guestIds: sanitizedGuestIds,
    invitedBy: req.user._id,
  });

  const notifiedUserIds = [...new Set([req.user._id.toString(), ...sanitizedMemberIds, ...sanitizedGuestIds])];
  await Promise.all(notifiedUserIds.map((userId) => createNotification({
    tenantId: req.user.tenantId,
    user: userId,
    type: 'workspace_assigned',
    title: 'Workspace created',
    message: userId === req.user._id.toString()
      ? `${name} is ready for collaboration`
      : `You have been assigned to ${name}`,
    relatedWorkspace: workspace._id,
    actionUrl: `/workspaces?workspace=${workspace._id}`,
  })));

  res.status(201).json({ status: 'success', data: { workspace } });
});

exports.getWorkspace = catchAsync(async (req, res, next) => {
  const workspace = await ensureWorkspaceAccess(req, req.params.workspaceId, next);
  if (!workspace) return;

  await workspace.populate('manager', 'firstName lastName email role');
  await workspace.populate('members.user', 'firstName lastName email role');
  await workspace.populate('guests.user', 'firstName lastName email role');

  res.status(200).json({ status: 'success', data: { workspace } });
});

exports.inviteMembers = catchAsync(async (req, res, next) => {
  const workspace = await ensureWorkspaceAccess(req, req.params.workspaceId, next);
  if (!workspace) return;

  if (!canManageWorkspace(req, workspace)) {
    return next(new AppError('Only managers can invite members', 403));
  }

  const { memberIds = [], guestIds = [] } = req.body;
  const invitedIds = [...new Set([...memberIds, ...guestIds].map(String).filter(Boolean))];
  const invitedUsers = invitedIds.length
    ? await User.find({ tenantId: req.user.tenantId, _id: { $in: invitedIds } })
    : [];
  const invitedMap = new Map(invitedUsers.map((user) => [user._id.toString(), user]));

  const mergeMembers = (existing, additions, permission) => {
    const next = existing.filter((entry) => !additions.includes(entry.user.toString()));
    additions.forEach((userId) => {
      if (!invitedMap.has(userId)) return;
      next.push({ user: userId, permission, invitedBy: req.user._id });
    });
    return next;
  };

  workspace.members = mergeMembers(workspace.members, memberIds.map(String), 'member');
  workspace.guests = mergeMembers(workspace.guests, guestIds.map(String), 'guest');
  await workspace.save();

  await syncWorkspaceMembers({
    tenantId: req.user.tenantId,
    workspaceId: workspace._id,
    managerId: workspace.manager,
    memberIds: workspace.members.map((member) => member.user.toString()),
    guestIds: workspace.guests.map((guest) => guest.user.toString()),
    invitedBy: req.user._id,
  });

  res.status(200).json({ status: 'success', data: { workspace } });
});

exports.archiveWorkspace = catchAsync(async (req, res, next) => {
  const workspace = await ensureWorkspaceAccess(req, req.params.workspaceId, next);
  if (!workspace) return;

  if (!canManageWorkspace(req, workspace)) {
    return next(new AppError('Only managers can archive workspaces', 403));
  }

  workspace.status = 'archived';
  workspace.reworkEnabled = false;
  workspace.archivedAt = new Date();
  await workspace.save();

  const archiveRecipients = [workspace.manager, ...(workspace.members || []).map((member) => member.user), ...(workspace.guests || []).map((guest) => guest.user)];
  await Promise.all([...new Set(archiveRecipients.map((value) => value.toString()))].map((userId) => createNotification({
    tenantId: req.user.tenantId,
    user: userId,
    type: 'workspace_archived',
    title: 'Workspace archived',
    message: `${workspace.name} moved to archive`,
    relatedWorkspace: workspace._id,
    actionUrl: `/workspaces?workspace=${workspace._id}`,
  })));

  res.status(200).json({ status: 'success', data: { workspace } });
});

exports.toggleRework = catchAsync(async (req, res, next) => {
  const workspace = await ensureWorkspaceAccess(req, req.params.workspaceId, next);
  if (!workspace) return;

  if (!canManageWorkspace(req, workspace)) {
    return next(new AppError('Only managers can change rework state', 403));
  }

  workspace.reworkEnabled = !workspace.reworkEnabled;
  workspace.status = workspace.reworkEnabled ? 'active' : 'archived';
  workspace.archivedAt = workspace.reworkEnabled ? null : new Date();
  await workspace.save();

  const reworkRecipients = [workspace.manager, ...(workspace.members || []).map((member) => member.user), ...(workspace.guests || []).map((guest) => guest.user)];
  await Promise.all([...new Set(reworkRecipients.map((value) => value.toString()))].map((userId) => createNotification({
    tenantId: req.user.tenantId,
    user: userId,
    type: workspace.reworkEnabled ? 'workspace_reopened' : 'workspace_archived',
    title: workspace.reworkEnabled ? 'Workspace reopened' : 'Workspace re-locked',
    message: workspace.reworkEnabled
      ? `${workspace.name} is open for rework`
      : `${workspace.name} returned to read-only archive`,
    relatedWorkspace: workspace._id,
    actionUrl: `/workspaces?workspace=${workspace._id}`,
  })));

  res.status(200).json({ status: 'success', data: { workspace } });
});

exports.deleteWorkspace = catchAsync(async (req, res, next) => {
  const workspace = await ensureWorkspaceManageAccess(req, req.params.workspaceId, next);
  if (!workspace) return;

  // Soft-delete all workspace documents so they disappear from active views.
  await Document.updateMany(
    { tenantId: req.user.tenantId, workspaceId: workspace._id, isDeleted: false },
    {
      $set: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: req.user._id,
      },
    },
  );

  await WorkspaceMember.deleteMany({ tenantId: req.user.tenantId, workspace: workspace._id });
  await Notification.deleteMany({ tenantId: req.user.tenantId, relatedWorkspace: workspace._id });
  await Workspace.deleteOne({ _id: workspace._id, tenantId: req.user.tenantId });

  emitTenantEvent(req.user.tenantId, 'workspace:deleted', {
    workspaceId: workspace._id.toString(),
    workspaceName: workspace.name,
    deletedBy: req.user._id.toString(),
    deletedAt: new Date().toISOString(),
  });

  res.status(200).json({
    status: 'success',
    message: 'Workspace deleted successfully',
  });
});

exports.getTerminology = catchAsync(async (req, res, next) => {
  const tenant = await Tenant.findOne({ tenantId: req.user.tenantId });
  if (!tenant) return next(new AppError('Tenant not found', 404));

  res.status(200).json({
    status: 'success',
    data: {
      terminology: tenant.settings?.terminology || { workspaceLabel: 'Workspaces' },
    },
  });
});

exports.updateTerminology = catchAsync(async (req, res, next) => {
  if (!isEnterpriseAdmin(req.user) && !isWorkspaceManager(req.user)) {
    return next(new AppError('Only managers can update terminology', 403));
  }

  const tenant = await Tenant.findOne({ tenantId: req.user.tenantId });
  if (!tenant) return next(new AppError('Tenant not found', 404));

  tenant.settings = tenant.settings || {};
  tenant.settings.terminology = tenant.settings.terminology || {};
  tenant.settings.terminology.workspaceLabel = req.body.workspaceLabel;
  await tenant.save();

  res.status(200).json({ status: 'success', data: { terminology: tenant.settings.terminology } });
});

const toRoleValue = (value = '') => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'guest') return 'Guest';
  if (normalized === 'workspace manager') return 'Workspace Manager';
  return 'Contributor';
};

const syncWorkspaceEmbeddedMembers = (workspace, userId, role, invitedBy) => {
  const normalizedUserId = String(userId);
  workspace.members = (workspace.members || []).filter((entry) => entry.user.toString() !== normalizedUserId);
  workspace.guests = (workspace.guests || []).filter((entry) => entry.user.toString() !== normalizedUserId);

  if (role === 'Guest') {
    workspace.guests.push({ user: userId, permission: 'guest', invitedBy: invitedBy || workspace.manager });
    return;
  }

  if (role !== 'Workspace Manager') {
    workspace.members.push({ user: userId, permission: 'member', invitedBy: invitedBy || workspace.manager });
  }
};

const ensureWorkspaceManageAccess = async (req, workspaceId, next) => {
  const workspace = await ensureWorkspaceAccess(req, workspaceId, next);
  if (!workspace) return null;

  if (!canManageWorkspace(req, workspace)) {
    next(new AppError('Only managers can manage workspace team settings', 403));
    return null;
  }

  return workspace;
};

exports.getWorkspaceMembers = catchAsync(async (req, res, next) => {
  const workspace = await ensureWorkspaceAccess(req, req.params.workspaceId, next);
  if (!workspace) return;

  const members = await WorkspaceMember.find({
    tenantId: req.user.tenantId,
    workspace: workspace._id,
    isActive: true,
  })
    .populate('user', 'firstName lastName email role isActive')
    .populate('invitedBy', 'firstName lastName email')
    .sort({ role: 1, createdAt: 1 });

  res.status(200).json({
    status: 'success',
    data: {
      workspace: {
        _id: workspace._id,
        name: workspace.name,
        status: workspace.status,
        reworkEnabled: workspace.reworkEnabled,
      },
      members,
    },
  });
});

exports.addInternalMember = catchAsync(async (req, res, next) => {
  const workspace = await ensureWorkspaceManageAccess(req, req.params.workspaceId, next);
  if (!workspace) return;

  const role = toRoleValue(req.body.role || 'Contributor');
  const { userId } = req.body;

  const user = await User.findOne({
    _id: userId,
    tenantId: req.user.tenantId,
    isActive: true,
  });

  if (!user) {
    return next(new AppError('User not found in this tenant', 404));
  }

  if (workspace.manager.toString() === user._id.toString() && role !== 'Workspace Manager') {
    return next(new AppError('Workspace manager role cannot be downgraded here', 400));
  }

  syncWorkspaceEmbeddedMembers(workspace, user._id, role, req.user._id);
  await workspace.save();

  await syncWorkspaceMembers({
    tenantId: req.user.tenantId,
    workspaceId: workspace._id,
    managerId: workspace.manager,
    memberIds: workspace.members.map((member) => member.user.toString()),
    guestIds: workspace.guests.map((guest) => guest.user.toString()),
    invitedBy: req.user._id,
  });

  await createNotification({
    tenantId: req.user.tenantId,
    user: user._id,
    type: 'workspace_assigned',
    title: role === 'Guest' ? 'Guest access granted' : 'Workspace access granted',
    message: `You were added to ${workspace.name} as ${role}`,
    relatedWorkspace: workspace._id,
    actionUrl: `/workspaces?workspace=${workspace._id}`,
  });

  res.status(200).json({ status: 'success', message: 'Member added successfully' });
});

exports.addGuestMember = catchAsync(async (req, res, next) => {
  const workspace = await ensureWorkspaceManageAccess(req, req.params.workspaceId, next);
  if (!workspace) return;

  const role = toRoleValue(req.body.role || 'Guest');
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email) {
    return next(new AppError('Guest email is required', 400));
  }

  let guestUser = await User.findOne({ email });

  if (guestUser && guestUser.tenantId !== req.user.tenantId) {
    return next(new AppError('A user with this email already exists in another organization and cannot be invited as a tenant guest.', 409));
  }

  if (!guestUser) {
    const local = email.split('@')[0] || 'guest';
    try {
      guestUser = await User.create({
        tenantId: req.user.tenantId,
        firstName: local.slice(0, 40),
        lastName: 'Guest',
        email,
        password: crypto.randomBytes(18).toString('hex'),
        role: role === 'Guest' ? 'Guest' : 'Contributor',
        isVerified: false,
      });
    } catch (error) {
      if (error?.code === 11000) {
        return next(new AppError('This email already exists and cannot be added as a new guest in this organization.', 409));
      }
      throw error;
    }
  }

  if (!guestUser.isActive) {
    return next(new AppError('Guest account exists but is inactive', 400));
  }

  syncWorkspaceEmbeddedMembers(workspace, guestUser._id, role, req.user._id);
  await workspace.save();

  await syncWorkspaceMembers({
    tenantId: req.user.tenantId,
    workspaceId: workspace._id,
    managerId: workspace.manager,
    memberIds: workspace.members.map((member) => member.user.toString()),
    guestIds: workspace.guests.map((guest) => guest.user.toString()),
    invitedBy: req.user._id,
  });

  await createNotification({
    tenantId: req.user.tenantId,
    user: guestUser._id,
    type: 'workspace_assigned',
    title: 'Workspace guest access',
    message: `You were invited to ${workspace.name} as ${role}`,
    relatedWorkspace: workspace._id,
    actionUrl: `/workspaces?workspace=${workspace._id}`,
  });

  const frontendBaseUrl = String(process.env.FRONTEND_URL || '').replace(/\/+$/, '');
  const fallbackBaseUrl = `${req.protocol}://${req.get('host')}`;
  const appBaseUrl = frontendBaseUrl || fallbackBaseUrl;
  const loginUrl = `${appBaseUrl}/login`;
  const forgotPasswordUrl = `${appBaseUrl}/forgot-password`;

  sendEmail({
    to: guestUser.email,
    subject: `You're invited to ${workspace.name} on GravySyncro`,
    template: 'workspaceGuestInvite',
    data: {
      name: guestUser.firstName || 'there',
      workspaceName: workspace.name,
      inviterName: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || req.user.email || 'A team member',
      role,
      loginUrl,
      forgotPasswordUrl,
    },
  }).catch((error) => {
    console.error('Failed to send workspace guest invite email:', error.message);
  });

  res.status(200).json({ status: 'success', message: 'Guest invited successfully' });
});

exports.updateWorkspaceMemberRole = catchAsync(async (req, res, next) => {
  const workspace = await ensureWorkspaceManageAccess(req, req.params.workspaceId, next);
  if (!workspace) return;

  const membership = await WorkspaceMember.findOne({
    _id: req.params.memberId,
    tenantId: req.user.tenantId,
    workspace: workspace._id,
    isActive: true,
  });

  if (!membership) {
    return next(new AppError('Workspace member not found', 404));
  }

  if (workspace.manager.toString() === membership.user.toString()) {
    return next(new AppError('Workspace manager role cannot be changed', 400));
  }

  const role = toRoleValue(req.body.role || 'Contributor');
  syncWorkspaceEmbeddedMembers(workspace, membership.user, role, req.user._id);
  await workspace.save();

  await syncWorkspaceMembers({
    tenantId: req.user.tenantId,
    workspaceId: workspace._id,
    managerId: workspace.manager,
    memberIds: workspace.members.map((member) => member.user.toString()),
    guestIds: workspace.guests.map((guest) => guest.user.toString()),
    invitedBy: req.user._id,
  });

  res.status(200).json({ status: 'success', message: 'Member role updated successfully' });
});

exports.removeWorkspaceMember = catchAsync(async (req, res, next) => {
  const workspace = await ensureWorkspaceManageAccess(req, req.params.workspaceId, next);
  if (!workspace) return;

  const membership = await WorkspaceMember.findOne({
    _id: req.params.memberId,
    tenantId: req.user.tenantId,
    workspace: workspace._id,
    isActive: true,
  });

  if (!membership) {
    return next(new AppError('Workspace member not found', 404));
  }

  if (workspace.manager.toString() === membership.user.toString()) {
    return next(new AppError('Workspace manager cannot be removed', 400));
  }

  const memberUserId = membership.user.toString();
  workspace.members = (workspace.members || []).filter((entry) => entry.user.toString() !== memberUserId);
  workspace.guests = (workspace.guests || []).filter((entry) => entry.user.toString() !== memberUserId);
  await workspace.save();

  await syncWorkspaceMembers({
    tenantId: req.user.tenantId,
    workspaceId: workspace._id,
    managerId: workspace.manager,
    memberIds: workspace.members.map((member) => member.user.toString()),
    guestIds: workspace.guests.map((guest) => guest.user.toString()),
    invitedBy: req.user._id,
  });

  res.status(200).json({ status: 'success', message: 'Member removed successfully' });
});

exports.getBrandingSettings = catchAsync(async (req, res, next) => {
  const tenant = await Tenant.findOne({ tenantId: req.user.tenantId });
  if (!tenant) return next(new AppError('Tenant not found', 404));

  res.status(200).json({
    status: 'success',
    data: {
      terminology: tenant.settings?.terminology || { workspaceLabel: 'Workspaces' },
      branding: tenant.branding || {},
    },
  });
});

exports.updateBrandingSettings = catchAsync(async (req, res, next) => {
  if (!isEnterpriseAdmin(req.user) && !isWorkspaceManager(req.user)) {
    return next(new AppError('Only managers can update branding settings', 403));
  }

  const tenant = await Tenant.findOne({ tenantId: req.user.tenantId });
  if (!tenant) return next(new AppError('Tenant not found', 404));

  const { workspaceLabel, projectLabel, caseLabel, jobLabel, logo, primaryColor, secondaryColor } = req.body;

  tenant.settings = tenant.settings || {};
  tenant.settings.terminology = tenant.settings.terminology || {};
  tenant.branding = tenant.branding || {};

  if (workspaceLabel) tenant.settings.terminology.workspaceLabel = workspaceLabel;
  if (projectLabel) tenant.settings.terminology.projectLabel = projectLabel;
  if (caseLabel) tenant.settings.terminology.caseLabel = caseLabel;
  if (jobLabel) tenant.settings.terminology.jobLabel = jobLabel;

  if (logo) {
    if (!/^data:image\/png;base64,/.test(logo)) {
      return next(new AppError('Logo must be a PNG data URL', 400));
    }
    tenant.branding.logo = logo;
  }

  if (primaryColor) tenant.branding.primaryColor = primaryColor;
  if (secondaryColor) tenant.branding.secondaryColor = secondaryColor;

  await tenant.save();

  res.status(200).json({
    status: 'success',
    data: {
      terminology: tenant.settings.terminology,
      branding: tenant.branding,
    },
  });
});