const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const Workspace = require('../models/Workspace');
const WorkspaceMember = require('../models/WorkspaceMember');
const User = require('../models/User');

const ROLE_PRIORITY = {
  'Workspace Manager': 3,
  Contributor: 2,
  Guest: 1,
};

const normalizeLegacyRole = (permission, fallbackRole = 'Contributor') => {
  if (!permission) return fallbackRole;

  const value = String(permission).trim().toLowerCase();
  if (value === 'manager' || value === 'workspace manager') return 'Workspace Manager';
  if (value === 'member' || value === 'contributor') return 'Contributor';
  if (value === 'guest' || value === 'client') return 'Guest';

  return fallbackRole;
};

const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = {
    dryRun: args.includes('--dry-run'),
    tenantId: null,
    workspaceId: null,
  };

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--tenantId' && args[i + 1]) {
      options.tenantId = args[i + 1];
      i += 1;
    }

    if (args[i] === '--workspaceId' && args[i + 1]) {
      options.workspaceId = args[i + 1];
      i += 1;
    }
  }

  return options;
};

const addCandidate = (membershipMap, userId, role, context) => {
  if (!userId) return;
  const key = String(userId);
  const nextRole = normalizeLegacyRole(role, 'Guest');
  const previous = membershipMap.get(key);

  if (!previous || ROLE_PRIORITY[nextRole] > ROLE_PRIORITY[previous.role]) {
    membershipMap.set(key, {
      user: key,
      role: nextRole,
      invitedBy: context.invitedBy || context.managerId || null,
      invitedAt: context.invitedAt || new Date(),
    });
  }
};

const buildDesiredMemberships = (workspace) => {
  const membershipMap = new Map();
  const managerId = workspace.manager?.toString() || null;

  addCandidate(membershipMap, managerId, 'Workspace Manager', {
    managerId,
    invitedBy: workspace.createdBy?.toString() || managerId,
    invitedAt: workspace.createdAt,
  });

  for (const member of workspace.members || []) {
    addCandidate(membershipMap, member.user?.toString(), member.permission || 'member', {
      managerId,
      invitedBy: member.invitedBy?.toString() || managerId,
      invitedAt: member.invitedAt,
    });
  }

  for (const guest of workspace.guests || []) {
    addCandidate(membershipMap, guest.user?.toString(), guest.permission || 'guest', {
      managerId,
      invitedBy: guest.invitedBy?.toString() || managerId,
      invitedAt: guest.invitedAt,
    });
  }

  return membershipMap;
};

const run = async () => {
  const { dryRun, tenantId, workspaceId } = parseArgs();

  if (!process.env.MONGODB_URI) {
    throw new Error('Missing MONGODB_URI in environment');
  }

  await mongoose.connect(process.env.MONGODB_URI, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  });

  const workspaceFilter = {};
  if (tenantId) workspaceFilter.tenantId = tenantId;
  if (workspaceId) workspaceFilter._id = workspaceId;

  const stats = {
    scannedWorkspaces: 0,
    upserts: 0,
    deactivations: 0,
    skippedUsers: 0,
  };

  console.log('Starting WorkspaceMember backfill...');
  if (dryRun) console.log('Mode: DRY RUN (no writes)');
  if (tenantId) console.log(`Filter: tenantId=${tenantId}`);
  if (workspaceId) console.log(`Filter: workspaceId=${workspaceId}`);

  const cursor = Workspace.find(workspaceFilter)
    .select('_id tenantId createdBy createdAt manager members guests')
    .lean()
    .cursor();

  for await (const workspace of cursor) {
    stats.scannedWorkspaces += 1;

    const desiredMembershipMap = buildDesiredMemberships(workspace);
    if (desiredMembershipMap.size === 0) {
      console.warn(`Workspace ${workspace._id} has no legacy memberships to backfill`);
      continue;
    }

    const desiredUserIds = [...desiredMembershipMap.keys()];
    const validUsers = await User.find({
      _id: { $in: desiredUserIds },
      tenantId: workspace.tenantId,
    })
      .select('_id')
      .lean();

    const validUserSet = new Set(validUsers.map((u) => String(u._id)));
    const upsertOperations = [];

    for (const [userId, membership] of desiredMembershipMap.entries()) {
      if (!validUserSet.has(userId)) {
        stats.skippedUsers += 1;
        console.warn(
          `Skipping user ${userId} for workspace ${workspace._id}: user missing or cross-tenant`,
        );
        continue;
      }

      upsertOperations.push({
        updateOne: {
          filter: {
            tenantId: workspace.tenantId,
            workspace: workspace._id,
            user: membership.user,
          },
          update: {
            $set: {
              role: membership.role,
              invitedBy: membership.invitedBy,
              invitedAt: membership.invitedAt || new Date(),
              isActive: true,
            },
            $setOnInsert: {
              tenantId: workspace.tenantId,
              workspace: workspace._id,
              user: membership.user,
            },
          },
          upsert: true,
        },
      });
    }

    let deactivationFilter = {
      tenantId: workspace.tenantId,
      workspace: workspace._id,
    };

    const desiredValidUserIds = [...validUserSet].filter((id) => desiredMembershipMap.has(id));
    if (desiredValidUserIds.length > 0) {
      deactivationFilter = {
        ...deactivationFilter,
        user: { $nin: desiredValidUserIds },
      };
    }

    if (!dryRun && upsertOperations.length > 0) {
      const bulkResult = await WorkspaceMember.bulkWrite(upsertOperations, { ordered: false });
      stats.upserts += (bulkResult.upsertedCount || 0) + (bulkResult.modifiedCount || 0);
    } else {
      stats.upserts += upsertOperations.length;
    }

    if (!dryRun) {
      const deactivateResult = await WorkspaceMember.updateMany(
        deactivationFilter,
        { $set: { isActive: false } },
      );
      stats.deactivations += deactivateResult.modifiedCount || 0;
    }
  }

  console.log('WorkspaceMember backfill complete');
  console.log(`Workspaces scanned: ${stats.scannedWorkspaces}`);
  console.log(`Membership upserts (created/updated): ${stats.upserts}`);
  console.log(`Memberships deactivated: ${stats.deactivations}`);
  console.log(`Users skipped (invalid tenant/missing): ${stats.skippedUsers}`);

  await mongoose.disconnect();
};

run()
  .then(() => {
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('WorkspaceMember backfill failed:', error);
    try {
      await mongoose.disconnect();
    } catch (disconnectError) {
      // Ignore disconnect errors during failure handling.
    }
    process.exit(1);
  });
