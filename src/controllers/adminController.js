const User = require('../models/User');
const Document = require('../models/Document');
const ActivityLog = require('../models/ActivityLog');
const Notification = require('../models/Notification');
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const { STORAGE_PLAN_GB_OPTIONS, gbToBytes } = require('../utils/storagePlans');
const { getTenantStorageMap, getTenantStorageSummary, applyTenantStoragePlan } = require('../utils/tenantStorage');
const { emitTenantEvent } = require('../config/socket');

/**
 * Get admin dashboard statistics
 */
exports.getDashboardStats = catchAsync(async (req, res, next) => {
  const [
    totalUsers,
    activeUsers,
    totalDocuments,
    totalTenants,
    recentActivity,
    storageUsed
  ] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ isActive: true }),
    Document.countDocuments({ isDeleted: false }),
    User.distinct('tenantId'),
    ActivityLog.countDocuments({ 
      createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } 
    }),
    Document.aggregate([
      { $match: { isDeleted: false } },
      { $group: { _id: null, total: { $sum: '$fileSize' } } }
    ])
  ]);

  // Get user growth (last 7 days)
  const last7Days = [];
  for (let i = 6; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    date.setHours(0, 0, 0, 0);
    last7Days.push(date);
  }

  const userGrowth = await Promise.all(
    last7Days.map(date => 
      User.countDocuments({ 
        createdAt: { $gte: date, $lt: new Date(date.getTime() + 24 * 60 * 60 * 1000) }
      })
    )
  );

  res.status(200).json({
    status: 'success',
    data: {
      stats: {
        totalUsers,
        activeUsers,
        inactiveUsers: totalUsers - activeUsers,
        totalDocuments,
        totalTenants: totalTenants.length,
        recentActivity,
        storageUsed: storageUsed[0]?.total || 0
      },
      userGrowth: last7Days.map((date, index) => ({
        date: date.toISOString().split('T')[0],
        count: userGrowth[index]
      }))
    }
  });
});

/**
 * Get all users (admin only - cross-tenant)
 */
exports.getAllUsers = catchAsync(async (req, res, next) => {
  const {
    page = 1,
    limit = 20,
    search,
    role,
    tenantId,
    isActive,
    storagePlanGb,
    sortBy = '-createdAt'
  } = req.query;

  // Build query
  const query = {};

  if (search) {
    query.$or = [
      { firstName: { $regex: search, $options: 'i' } },
      { lastName: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
      { organization: { $regex: search, $options: 'i' } }
    ];
  }

  if (role) query.role = role;
  if (tenantId) query.tenantId = tenantId;
  if (isActive !== undefined) query.isActive = isActive === 'true';
  if (storagePlanGb) query.storagePlanGb = Number(storagePlanGb);

  const skip = (page - 1) * limit;

  const [users, total] = await Promise.all([
    User.find(query)
      .select('-password -twoFactorSecret')
      .sort(sortBy)
      .skip(skip)
      .limit(parseInt(limit))
      .lean(),
    User.countDocuments(query)
  ]);

  const tenantStorageMap = await getTenantStorageMap(users.map((user) => user.tenantId));

  const usersWithStorage = users.map((user) => {
    const tenantStorage = tenantStorageMap.get(user.tenantId) || {
      storageUsed: Number(user.storageUsed || 0),
      storageLimit: Number(user.storageLimit || 0),
      storagePlanGb: user.storagePlanGb || 50,
      storageRemaining: Math.max(Number(user.storageLimit || 0) - Number(user.storageUsed || 0), 0),
      storageUsedPercentage: Number(user.storageLimit || 0) > 0
        ? Number(((Number(user.storageUsed || 0) / Number(user.storageLimit || 0)) * 100).toFixed(2))
        : 0,
    };

    return {
      ...user,
      storageUsed: tenantStorage.storageUsed,
      storageLimit: tenantStorage.storageLimit,
      storagePlanGb: tenantStorage.storagePlanGb,
      storageRemaining: tenantStorage.storageRemaining,
      storageUsedPercentage: tenantStorage.storageUsedPercentage,
    };
  });

  res.status(200).json({
    status: 'success',
    results: usersWithStorage.length,
    data: {
      users: usersWithStorage,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    }
  });
});

/**
 * Get all tenants with statistics
 */
exports.getAllTenants = catchAsync(async (req, res, next) => {
  const tenantIds = await User.distinct('tenantId');
  const tenantStorageMap = await getTenantStorageMap(tenantIds);

  const tenants = await Promise.all(
    tenantIds.map(async (tenantId) => {
      const [userCount, documentCount, activeUsers, recentActivity] = await Promise.all([
        User.countDocuments({ tenantId }),
        Document.countDocuments({ tenantId, isDeleted: false }),
        User.countDocuments({ tenantId, isActive: true }),
        ActivityLog.countDocuments({ 
          tenantId,
          createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
        })
      ]);

      const users = await User.find({ tenantId })
        .select('firstName lastName email role createdAt')
        .limit(5);

      const primaryUser = users[0] || null;
      const storage = tenantStorageMap.get(tenantId) || {
        storageUsed: 0,
        storageLimit: gbToBytes(50),
        storagePlanGb: 50,
        storageRemaining: gbToBytes(50),
        storageUsedPercentage: 0,
      };

      return {
        tenantId,
        primaryUser,
        userCount,
        documentCount,
        activeUsers,
        recentActivity,
        users,
        createdAt: primaryUser?.createdAt,
        storageUsed: storage.storageUsed,
        storageLimit: storage.storageLimit,
        storagePlanGb: storage.storagePlanGb,
        storageRemaining: storage.storageRemaining,
        storageUsedPercentage: storage.storageUsedPercentage,
      };
    })
  );

  // Sort by creation date
  tenants.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.status(200).json({
    status: 'success',
    results: tenants.length,
    data: { tenants }
  });
});

/**
 * Get user details by ID
 */
exports.getUserById = catchAsync(async (req, res, next) => {
  const user = await User.findById(req.params.userId)
    .select('-password -twoFactorSecret');

  if (!user) {
    return next(new AppError('User not found', 404));
  }

  // Get user's documents
  const documents = await Document.find({ 
    owner: user._id,
    isDeleted: false 
  }).select('title type fileSize createdAt').limit(10);

  // Get user's recent activity
  const activities = await ActivityLog.find({ user: user._id })
    .sort('-createdAt')
    .limit(20);

  res.status(200).json({
    status: 'success',
    data: {
      user,
      documents,
      activities
    }
  });
});

/**
 * Deactivate user
 */
exports.deactivateUser = catchAsync(async (req, res, next) => {
  const { userId } = req.params;
  const { reason } = req.body;

  const user = await User.findById(userId);

  if (!user) {
    return next(new AppError('User not found', 404));
  }

  if (user.role === 'Admin') {
    return next(new AppError('Cannot deactivate admin users', 403));
  }

  user.isActive = false;
  await user.save();

  // Log the action
  await ActivityLog.create({
    tenantId: user.tenantId,
    user: req.user._id,
    action: 'settings_change',
    resourceType: 'user',
    resourceId: user._id,
    details: {
      action: 'user_deactivated',
      reason,
      deactivatedBy: req.user.email
    },
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
    status: 'success'
  });

  res.status(200).json({
    status: 'success',
    message: 'User deactivated successfully',
    data: { user }
  });
});

/**
 * Activate user
 */
exports.activateUser = catchAsync(async (req, res, next) => {
  const { userId } = req.params;

  const user = await User.findById(userId);

  if (!user) {
    return next(new AppError('User not found', 404));
  }

  user.isActive = true;
  await user.save();

  // Log the action
  await ActivityLog.create({
    tenantId: user.tenantId,
    user: req.user._id,
    action: 'settings_change',
    resourceType: 'user',
    resourceId: user._id,
    details: {
      action: 'user_activated',
      activatedBy: req.user.email
    },
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
    status: 'success'
  });

  res.status(200).json({
    status: 'success',
    message: 'User activated successfully',
    data: { user }
  });
});

/**
 * Delete user permanently
 */
exports.deleteUser = catchAsync(async (req, res, next) => {
  const { userId } = req.params;

  const user = await User.findById(userId);

  if (!user) {
    return next(new AppError('User not found', 404));
  }

  if (user.role === 'Admin') {
    return next(new AppError('Cannot delete admin users', 403));
  }

  // Delete user's documents
  await Document.deleteMany({ owner: user._id });

  // Delete user's activities
  await ActivityLog.deleteMany({ user: user._id });

  // Delete user's notifications
  await Notification.deleteMany({ user: user._id });

  // Delete user
  await user.deleteOne();

  res.status(200).json({
    status: 'success',
    message: 'User and all associated data deleted successfully'
  });
});

/**
 * Get all activity logs (cross-tenant)
 */
exports.getActivityLogs = catchAsync(async (req, res, next) => {
  const {
    page = 1,
    limit = 50,
    tenantId,
    action,
    status,
    userId,
    search,
    startDate,
    endDate
  } = req.query;

  const query = {};

  if (tenantId) query.tenantId = tenantId;
  if (action) query.action = action;
  if (status) query.status = status;
  if (userId) query.user = userId;

  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) query.createdAt.$gte = new Date(startDate);
    if (endDate) query.createdAt.$lte = new Date(endDate);
  }

  const skip = (page - 1) * limit;

  // First get activities, then filter by user search if needed
  let activitiesQuery = ActivityLog.find(query)
    .populate('user', 'firstName lastName email')
    .sort('-createdAt');

  if (!search) {
    // No search filter, use pagination directly
    const [activities, total] = await Promise.all([
      activitiesQuery
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      ActivityLog.countDocuments(query)
    ]);
    
    return res.status(200).json({
      status: 'success',
      results: activities.length,
      data: {
        activities,
        totalPages: Math.ceil(total / limit),
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  }

  // With search filter, we need to get all activities first, then filter
  const allActivities = await activitiesQuery.lean();
  
  // Filter by user name or email
  const searchLower = search.toLowerCase();
  const filteredActivities = allActivities.filter(activity => {
    if (!activity.user) return false;
    const fullName = `${activity.user.firstName || ''} ${activity.user.lastName || ''}`.toLowerCase();
    const email = (activity.user.email || '').toLowerCase();
    return fullName.includes(searchLower) || email.includes(searchLower);
  });

  const total = filteredActivities.length;
  const paginatedActivities = filteredActivities.slice(skip, skip + parseInt(limit));

  const [activities] = await Promise.all([
    Promise.resolve(paginatedActivities)
  ]);

  res.status(200).json({
    status: 'success',
    results: activities.length,
    data: {
      activities,
      totalPages: Math.ceil(total / limit),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    }
  });
});

/**
 * Get all documents (cross-tenant)
 */
exports.getAllDocuments = catchAsync(async (req, res, next) => {
  const {
    page = 1,
    limit = 20,
    search,
    tenantId,
    type,
    sortBy = '-createdAt'
  } = req.query;

  const query = { isDeleted: false };

  if (search) {
    query.$or = [
      { title: { $regex: search, $options: 'i' } },
      { description: { $regex: search, $options: 'i' } }
    ];
  }

  if (tenantId) query.tenantId = tenantId;
  if (type) query.type = type;

  const skip = (page - 1) * limit;

  const [documents, total] = await Promise.all([
    Document.find(query)
      .populate('owner', 'firstName lastName email')
      .sort(sortBy)
      .skip(skip)
      .limit(parseInt(limit))
      .lean(),
    Document.countDocuments(query)
  ]);

  res.status(200).json({
    status: 'success',
    results: documents.length,
    data: {
      documents,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    }
  });
});

/**
 * Update user role
 */
exports.updateUserRole = catchAsync(async (req, res, next) => {
  const { userId } = req.params;
  const { role } = req.body;

  const user = await User.findById(userId);

  if (!user) {
    return next(new AppError('User not found', 404));
  }

  const oldRole = user.role;
  user.role = role;
  await user.save();

  // Log the action
  await ActivityLog.create({
    tenantId: user.tenantId,
    user: req.user._id,
    action: 'settings_change',
    resourceType: 'user',
    resourceId: user._id,
    details: {
      action: 'role_updated',
      oldRole,
      newRole: role,
      updatedBy: req.user.email
    },
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
    status: 'success'
  });

  res.status(200).json({
    status: 'success',
    message: 'User role updated successfully',
    data: { user }
  });
});

/**
 * Reset user password (admin only)
 */
exports.resetUserPassword = catchAsync(async (req, res, next) => {
  const { userId } = req.params;
  const { newPassword } = req.body;

  if (!newPassword) {
    return next(new AppError('New password is required', 400));
  }

  if (newPassword.length < 8 || newPassword.length > 128) {
    return next(new AppError('Password must be between 8 and 128 characters', 400));
  }

  const passwordPattern = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/;
  if (!passwordPattern.test(newPassword)) {
    return next(new AppError('Password must contain at least one lowercase letter, one uppercase letter, and one number', 400));
  }

  const user = await User.findById(userId).select('+password');

  if (!user) {
    return next(new AppError('User not found', 404));
  }

  if (user.role === 'Admin') {
    return next(new AppError('Cannot reset password for admin users', 403));
  }

  user.password = newPassword;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  await user.save();

  await ActivityLog.create({
    tenantId: user.tenantId,
    user: req.user._id,
    action: 'password_change',
    resourceType: 'user',
    resourceId: user._id,
    details: {
      action: 'admin_password_reset',
      resetBy: req.user.email,
      targetUserEmail: user.email
    },
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
    status: 'success'
  });

  res.status(200).json({
    status: 'success',
    message: 'User password reset successfully'
  });
});

/**
 * Update user storage limit plan (admin only)
 */
const updateEnterpriseStorage = async ({ tenantId, req, res, next }) => {
  const { storagePlanGb } = req.body;
  const normalizedPlan = Number(storagePlanGb);

  if (!STORAGE_PLAN_GB_OPTIONS.includes(normalizedPlan)) {
    return next(
      new AppError(
        `Invalid storage plan. Allowed plans are: ${STORAGE_PLAN_GB_OPTIONS.join(', ')} GB`,
        400
      )
    );
  }

  const tenantStorageBefore = await getTenantStorageSummary(tenantId);
  const storageLimit = await applyTenantStoragePlan(tenantId, normalizedPlan);

  await ActivityLog.create({
    tenantId,
    user: req.user._id,
    action: 'settings_change',
    resourceType: 'tenant',
    details: {
      action: 'enterprise_storage_updated',
      tenantId,
      oldPlanGb: tenantStorageBefore.storagePlanGb || 50,
      newPlanGb: normalizedPlan,
      updatedBy: req.user.email,
    },
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
    status: 'success',
  });

  const tenantStorage = await getTenantStorageSummary(tenantId);

  emitTenantEvent(tenantId, 'tenant:storage-updated', {
    tenantId,
    storagePlanGb: normalizedPlan,
    storageLimit,
    storageUsed: tenantStorage.storageUsed,
    storageUsedPercentage: tenantStorage.storageUsedPercentage,
    updatedAt: new Date().toISOString(),
  });

  res.status(200).json({
    status: 'success',
    message: `Enterprise storage plan updated to ${normalizedPlan} GB`,
    data: {
      tenant: {
        tenantId,
        storagePlanGb: normalizedPlan,
        storageUsed: tenantStorage.storageUsed,
        storageLimit,
        storageUsedPercentage: tenantStorage.storageUsedPercentage,
      },
    },
  });
};

exports.updateUserStorageLimit = catchAsync(async (req, res, next) => {
  const { userId } = req.params;
  const user = await User.findById(userId);

  if (!user) {
    return next(new AppError('User not found', 404));
  }

  return updateEnterpriseStorage({
    tenantId: user.tenantId,
    storagePlanGb: req.body.storagePlanGb,
    req,
    res,
    next,
  });
});

exports.updateTenantStorageLimit = catchAsync(async (req, res, next) => {
  const { tenantId } = req.params;

  if (!tenantId) {
    return next(new AppError('Tenant ID is required', 400));
  }

  return updateEnterpriseStorage({
    tenantId,
    storagePlanGb: req.body.storagePlanGb,
    req,
    res,
    next,
  });
});

/**
 * Get system health
 */
exports.getSystemHealth = catchAsync(async (req, res, next) => {
  const mongoose = require('mongoose');
  const AWS = require('aws-sdk');
  const os = require('os');

  // Helper function to add timeout to promises
  const withTimeout = (promise, timeoutMs, timeoutMessage) => {
    return Promise.race([
      promise,
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
      )
    ]);
  };

  // Check MongoDB connection (with timeout)
  const checkDatabase = async () => {
    let dbHealth = {
      status: 'disconnected',
      responseTime: null,
      error: null
    };

    try {
      const startTime = Date.now();
      await User.findOne().lean().maxTimeMS(3000);
      const endTime = Date.now();
      
      dbHealth = {
        status: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        responseTime: endTime - startTime,
        host: mongoose.connection.host,
        database: mongoose.connection.name,
        readyState: mongoose.connection.readyState,
        collections: Object.keys(mongoose.connection.collections).length
      };
    } catch (error) {
      dbHealth.status = 'error';
      dbHealth.error = error.message;
    }
    return dbHealth;
  };

  // Check Wasabi S3 connection (with timeout)
  const checkWasabi = async () => {
    let wasabiHealth = {
      status: 'unknown',
      responseTime: null,
      error: null
    };

    if (process.env.WASABI_ENDPOINT && process.env.WASABI_ACCESS_KEY_ID) {
      try {
        const s3 = new AWS.S3({
          endpoint: process.env.WASABI_ENDPOINT,
          region: process.env.WASABI_REGION,
          accessKeyId: process.env.WASABI_ACCESS_KEY_ID,
          secretAccessKey: process.env.WASABI_SECRET_ACCESS_KEY,
          signatureVersion: 'v4',
          s3ForcePathStyle: true,
          httpOptions: { timeout: 3000 }
        });

        const startTime = Date.now();
        // Add 5 second timeout to prevent hanging
        await withTimeout(
          s3.headBucket({ Bucket: process.env.WASABI_BUCKET }).promise(),
          5000,
          'Wasabi health check timeout'
        );
        const endTime = Date.now();

        wasabiHealth = {
          status: 'connected',
          responseTime: endTime - startTime,
          bucket: process.env.WASABI_BUCKET,
          region: process.env.WASABI_REGION
        };
      } catch (error) {
        wasabiHealth.status = 'error';
        wasabiHealth.error = error.message;
      }
    } else {
      wasabiHealth.status = 'not_configured';
    }
    return wasabiHealth;
  };

  // Run health checks in parallel for faster response
  const [dbHealth, wasabiHealth] = await Promise.all([
    checkDatabase(),
    checkWasabi()
  ]);

  // System resources
  const memoryUsage = process.memoryUsage();
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = totalMemory - freeMemory;

  const systemHealth = {
    cpu: {
      cores: os.cpus().length,
      model: os.cpus()[0].model,
      loadAverage: os.loadavg()
    },
    memory: {
      total: totalMemory,
      free: freeMemory,
      used: usedMemory,
      usagePercentage: ((usedMemory / totalMemory) * 100).toFixed(2),
      process: {
        heapUsed: memoryUsage.heapUsed,
        heapTotal: memoryUsage.heapTotal,
        external: memoryUsage.external,
        rss: memoryUsage.rss
      }
    },
    uptime: {
      system: os.uptime(),
      process: process.uptime()
    },
    platform: os.platform(),
    nodeVersion: process.version
  };

  // Overall system status
  const overallStatus = 
    dbHealth.status === 'connected' && 
    (wasabiHealth.status === 'connected' || wasabiHealth.status === 'not_configured')
      ? 'healthy'
      : 'degraded';

  res.status(200).json({
    status: 'success',
    data: {
      overallStatus,
      timestamp: new Date(),
      services: {
        database: dbHealth,
        storage: wasabiHealth
      },
      system: systemHealth
    }
  });
});
