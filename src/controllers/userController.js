const User = require('../models/User');
const Tenant = require('../models/Tenant');
const PlanChangeRequest = require('../models/PlanChangeRequest');
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const { log } = require('../middleware/activityLogger');
const { getTenantStorageSummary } = require('../utils/tenantStorage');
const { STORAGE_PLANS } = require('../utils/storagePlans');
const { createNotification } = require('./notificationController');
const { sendSlackMessage } = require('../services/slackService');

/**
 * Get current user profile
 */
exports.getProfile = catchAsync(async (req, res, next) => {
  const [user, tenantStorage, tenant] = await Promise.all([
    User.findById(req.user._id),
    getTenantStorageSummary(req.user.tenantId),
    Tenant.findOne({ tenantId: req.user.tenantId }).select('subscription.plan subscription.status'),
  ]);

  if (!user) {
    return next(new AppError('User not found', 404));
  }

  const effectiveUser = {
    ...user.toObject(),
    storageUsed: tenantStorage.storageUsed,
    storageLimit: tenantStorage.storageLimit,
    storagePlanGb: tenantStorage.storagePlanGb,
    storageRemaining: tenantStorage.storageRemaining,
    storageUsedPercentage: tenantStorage.storageUsedPercentage,
    subscription: {
      plan: tenant?.subscription?.plan || 'enterprise',
      status: tenant?.subscription?.status || 'active',
    },
  };

  res.status(200).json({
    status: 'success',
    data: {
      user: effectiveUser,
      tenantStorage: {
        storageUsed: tenantStorage.storageUsed,
        storageLimit: tenantStorage.storageLimit,
        storagePlanGb: tenantStorage.storagePlanGb,
        storageRemaining: tenantStorage.storageRemaining,
        storageUsedPercentage: tenantStorage.storageUsedPercentage,
      },
    },
  });
});

/**
 * Update user profile
 */
exports.updateProfile = catchAsync(async (req, res, next) => {
  const { firstName, lastName, phone, organization, bio, preferences } = req.body;

  // Fields that are not allowed to be updated here
  if (req.body.password || req.body.email || req.body.role) {
    return next(new AppError('This route is not for password, email, or role updates', 400));
  }

  const user = await User.findById(req.user._id);

  // Update allowed fields
  if (firstName) user.firstName = firstName;
  if (lastName) user.lastName = lastName;
  if (phone !== undefined) user.phone = phone;
  if (organization !== undefined) user.organization = organization;
  if (bio !== undefined) user.bio = bio;
  if (preferences) user.preferences = { ...user.preferences, ...preferences };

  await user.save();

  // Log activity
  await log(req, 'profile_update', 'user', user._id);

  res.status(200).json({
    status: 'success',
    data: {
      user,
    },
  });
});

/**
 * Get all users (admin only)
 */
exports.getAllUsers = catchAsync(async (req, res, next) => {
  const {
    page = 1,
    limit = 20,
    search,
    role,
    isActive,
    sortBy = '-createdAt',
  } = req.query;

  // Build query
  const query = {
    tenantId: req.user.tenantId,
  };

  // Search
  if (search) {
    query.$or = [
      { firstName: { $regex: search, $options: 'i' } },
      { lastName: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
    ];
  }

  // Filter by role
  if (role) {
    query.role = role;
  }

  // Filter by active status
  if (isActive !== undefined) {
    query.isActive = isActive === 'true';
  }

  // Execute query
  const users = await User.find(query)
    .sort(sortBy)
    .limit(limit * 1)
    .skip((page - 1) * limit)
    .select('-password -twoFactorSecret');

  // Get total count
  const total = await User.countDocuments(query);

  res.status(200).json({
    status: 'success',
    results: users.length,
    total,
    page: parseInt(page),
    pages: Math.ceil(total / limit),
    data: {
      users,
    },
  });
});

/**
 * Get user by ID (admin only)
 */
exports.getUser = catchAsync(async (req, res, next) => {
  const user = await User.findOne({
    _id: req.params.id,
    tenantId: req.user.tenantId,
  }).select('-password -twoFactorSecret');

  if (!user) {
    return next(new AppError('User not found', 404));
  }

  res.status(200).json({
    status: 'success',
    data: {
      user,
    },
  });
});

/**
 * Update user (admin only)
 */
exports.updateUser = catchAsync(async (req, res, next) => {
  const { firstName, lastName, email, role, isActive } = req.body;

  const user = await User.findOne({
    _id: req.params.id,
    tenantId: req.user.tenantId,
  });

  if (!user) {
    return next(new AppError('User not found', 404));
  }

  // Update fields
  if (firstName) user.firstName = firstName;
  if (lastName) user.lastName = lastName;
  if (email) user.email = email;
  if (role) user.role = role;
  if (isActive !== undefined) user.isActive = isActive;

  await user.save();

  // Log activity
  await log(req, 'user_update', 'user', user._id);

  res.status(200).json({
    status: 'success',
    data: {
      user,
    },
  });
});

/**
 * Delete user (admin only)
 */
exports.deleteUser = catchAsync(async (req, res, next) => {
  const user = await User.findOne({
    _id: req.params.id,
    tenantId: req.user.tenantId,
  });

  if (!user) {
    return next(new AppError('User not found', 404));
  }

  // Don't allow deleting yourself
  if (user._id.toString() === req.user._id.toString()) {
    return next(new AppError('You cannot delete your own account', 400));
  }

  // Soft delete - deactivate account
  user.isActive = false;
  await user.save();

  // Log activity
  await log(req, 'user_delete', 'user', user._id);

  res.status(200).json({
    status: 'success',
    message: 'User deleted successfully',
  });
});

/**
 * Get user activity logs
 */
exports.getUserActivity = catchAsync(async (req, res, next) => {
  const {
    page = 1,
    limit = 50,
    action,
    startDate,
    endDate,
  } = req.query;

  const ActivityLog = require('../models/ActivityLog');

  // Build query
  const query = {
    user: req.params.id || req.user._id,
    tenantId: req.user.tenantId,
  };

  // Filter by action
  if (action) {
    query.action = action;
  }

  // Filter by date range
  if (startDate || endDate) {
    query.timestamp = {};
    if (startDate) query.timestamp.$gte = new Date(startDate);
    if (endDate) query.timestamp.$lte = new Date(endDate);
  }

  // Execute query
  const activities = await ActivityLog.find(query)
    .populate('user', 'firstName lastName email')
    .sort('-timestamp')
    .limit(limit * 1)
    .skip((page - 1) * limit);

  // Get total count
  const total = await ActivityLog.countDocuments(query);

  res.status(200).json({
    status: 'success',
    results: activities.length,
    total,
    page: parseInt(page),
    pages: Math.ceil(total / limit),
    data: {
      activities,
    },
  });
});

/**
 * Get user statistics
 */
exports.getUserStats = catchAsync(async (req, res, next) => {
  const Document = require('../models/Document');
  const Comment = require('../models/Comment');

  const userId = req.params.id || req.user._id;

  // Get document stats
  const documentStats = await Document.aggregate([
    {
      $match: {
        uploadedBy: userId,
        tenantId: req.user.tenantId,
        isDeleted: false,
      },
    },
    {
      $group: {
        _id: null,
        totalDocuments: { $sum: 1 },
        totalSize: { $sum: '$size' },
        categories: { $addToSet: '$category' },
      },
    },
  ]);

  // Get shared documents count
  const sharedCount = await Document.countDocuments({
    'sharedWith.user': userId,
    tenantId: req.user.tenantId,
    isDeleted: false,
  });

  // Get comments count
  const commentsCount = await Comment.countDocuments({
    author: userId,
    tenantId: req.user.tenantId,
  });

  res.status(200).json({
    status: 'success',
    data: {
      documents: documentStats[0] || {
        totalDocuments: 0,
        totalSize: 0,
        categories: [],
      },
      sharedDocuments: sharedCount,
      comments: commentsCount,
    },
  });
});

/**
 * Update user preferences
 */
exports.updatePreferences = catchAsync(async (req, res, next) => {
  const user = await User.findById(req.user._id);

  user.preferences = {
    ...user.preferences,
    ...req.body,
  };

  await user.save();

  res.status(200).json({
    status: 'success',
    data: {
      preferences: user.preferences,
    },
  });
});

/**
 * Search users
 */
exports.searchUsers = catchAsync(async (req, res, next) => {
  const { q, limit = 10 } = req.query;

  if (!q) {
    return next(new AppError('Please provide a search query', 400));
  }

  const users = await User.find({
    tenantId: req.user.tenantId,
    isActive: true,
    $or: [
      { firstName: { $regex: q, $options: 'i' } },
      { lastName: { $regex: q, $options: 'i' } },
      { email: { $regex: q, $options: 'i' } },
    ],
  })
    .select('firstName lastName email')
    .limit(parseInt(limit));

  res.status(200).json({
    status: 'success',
    results: users.length,
    data: {
      users,
    },
  });
});

/**
 * List the available enterprise subscription/storage plans.
 */
exports.getSubscriptionPlans = catchAsync(async (req, res) => {
  res.status(200).json({
    status: 'success',
    data: {
      plans: STORAGE_PLANS,
    },
  });
});

/**
 * Self-service: request a different storage plan for the current user's
 * tenant. This used to apply immediately; now it only opens a
 * PlanChangeRequest for an admin to review from the Plan Requests tab —
 * see adminController.approvePlanRequest, which is what actually calls
 * applyTenantStoragePlan / createInvoiceForTenant once approved. The plan
 * is shared across the whole tenant, so approval affects every member.
 */
exports.updateSubscriptionPlan = catchAsync(async (req, res, next) => {
  const { storagePlanGb } = req.body;
  const normalizedPlan = Number(storagePlanGb);

  // Only monthly plans can be self-served here — this endpoint doesn't
  // collect payment or set billingCycle/currentPeriodEnd, so the annual
  // enterprise tiers (Enterprise 1TB/2TB) must go through an admin via
  // adminController.updateEnterpriseStorage instead.
  const monthlyPlan = STORAGE_PLANS.find(
    (plan) => plan.billingCycle !== 'yearly' && plan.storageGb === normalizedPlan
  );

  if (!monthlyPlan) {
    const monthlyPlanGbOptions = STORAGE_PLANS
      .filter((plan) => plan.billingCycle !== 'yearly')
      .map((plan) => plan.storageGb);

    return next(
      new AppError(
        `Invalid storage plan. Allowed plans are: ${monthlyPlanGbOptions.join(', ')} GB`,
        400
      )
    );
  }

  const tenantId = req.user.tenantId;
  const tenantStorage = await getTenantStorageSummary(tenantId);

  if (monthlyPlan.storageGb === (tenantStorage.storagePlanGb || 50)) {
    return next(new AppError('You are already on this plan.', 400));
  }

  const existingPending = await PlanChangeRequest.findOne({ tenantId, status: 'pending' });
  if (existingPending) {
    return next(new AppError('You already have a plan change request pending admin approval.', 409));
  }

  const request = await PlanChangeRequest.create({
    tenantId,
    requestedBy: req.user._id,
    currentPlanGb: tenantStorage.storagePlanGb || 50,
    requestedPlanGb: monthlyPlan.storageGb,
    requestedPlanId: monthlyPlan.id,
    requestedPlanName: monthlyPlan.name,
  });

  await log(req, 'settings_change', 'tenant', null, {
    action: 'subscription_plan_change_requested',
    tenantId,
    oldPlanGb: tenantStorage.storagePlanGb || 50,
    newPlanGb: monthlyPlan.storageGb,
    requestedBy: req.user.email,
  });

  // Notify every admin — same pattern as messageController's support-message
  // alert: createNotification saves the row and pushes it live over
  // socket.io, and Slack is a fire-and-forget best-effort heads-up on top.
  const admins = await User.find({ role: 'Admin' });
  await Promise.all(admins.map((admin) => createNotification({
    tenantId: admin.tenantId,
    user: admin._id,
    type: 'plan_change_requested',
    title: 'Plan change request',
    message: `${req.user.firstName} ${req.user.lastName} requested to switch to the `
      + `${monthlyPlan.name} plan (${monthlyPlan.storageGb} GB).`,
    relatedUser: req.user._id,
  })));

  sendSlackMessage(
    [
      ':page_facing_up: *New plan change request*',
      `*From:* ${req.user.firstName} ${req.user.lastName} (${req.user.email})`,
      `*Plan:* ${tenantStorage.storagePlanGb || 50} GB → ${monthlyPlan.name} (${monthlyPlan.storageGb} GB)`,
    ].join('\n')
  );

  res.status(201).json({
    status: 'success',
    message: `Your request to switch to the ${monthlyPlan.name} plan has been sent for admin approval.`,
    data: { request },
  });
});

/**
 * The current tenant's pending plan change request, if any — lets
 * Billing.jsx show "pending approval" state instead of letting a member
 * queue up a second request.
 */
exports.getPendingPlanRequest = catchAsync(async (req, res) => {
  const request = await PlanChangeRequest.findOne({
    tenantId: req.user.tenantId,
    status: 'pending',
  }).sort({ createdAt: -1 });

  res.status(200).json({
    status: 'success',
    data: { request },
  });
});
