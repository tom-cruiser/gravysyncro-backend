const ExcelJS = require('exceljs');
const mongoose = require('mongoose');

const Document = require('../models/Document');
const Video = require('../models/Video');
const Workspace = require('../models/Workspace');
const ActivityLog = require('../models/ActivityLog');
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const { canManageWorkspace, isEnterpriseAdmin, isWorkspaceManager } = require('../utils/workspaceAccess');
const { LIFECYCLE_STATES } = require('../utils/assetLifecycle');

const assetModels = {
  document: Document,
  video: Video,
};

const REPORT_PERIODS = {
  day: 'day',
  daily: 'day',
  month: 'month',
  monthly: 'month',
  year: 'year',
  yearly: 'year',
};

const DEFAULT_REPORT_PERIOD = 'month';
const BOTTLENECK_STATES = ['STARTED', 'IN_PROGRESS', 'NEEDS_REVIEW', 'REJECTED'];
const STORAGE_STATES = ['FINISHED', 'ARCHIVED'];

const parseDateBound = (value, label) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(`Invalid ${label}.`, 400);
  }
  return parsed;
};

const startOfPeriod = (period) => {
  const now = new Date();
  const start = new Date(now);

  if (period === 'day') {
    start.setHours(0, 0, 0, 0);
    return start;
  }

  if (period === 'month') {
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    return start;
  }

  if (period === 'year') {
    start.setMonth(0, 1);
    start.setHours(0, 0, 0, 0);
    return start;
  }

  throw new AppError('Invalid period. Use day, month, or year.', 400);
};

const parseReportWindow = (req) => {
  const explicitStart = parseDateBound(req.query.startDate, 'startDate');
  const explicitEnd = parseDateBound(req.query.endDate, 'endDate');

  if (explicitStart || explicitEnd) {
    const endDate = explicitEnd || new Date();
    const startDate = explicitStart || new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

    if (startDate > endDate) {
      throw new AppError('startDate must be earlier than endDate.', 400);
    }

    return { startDate, endDate, period: null };
  }

  const normalizedPeriod = REPORT_PERIODS[String(req.query.period || DEFAULT_REPORT_PERIOD).toLowerCase()]
    || DEFAULT_REPORT_PERIOD;
  const startDate = startOfPeriod(normalizedPeriod);
  const endDate = new Date();

  if (startDate > endDate) {
    throw new AppError('startDate must be earlier than endDate.', 400);
  }

  return { startDate, endDate, period: normalizedPeriod };
};

const parseLifecycleStateFilter = (value) => {
  if (!value || value === 'all') {
    return null;
  }

  const requested = String(value)
    .split(',')
    .map((state) => state.trim())
    .filter(Boolean);

  const validStates = [...new Set(requested.filter((state) => LIFECYCLE_STATES.includes(state)))];

  if (!validStates.length) {
    throw new AppError('Invalid lifecycle state filter.', 400);
  }

  return validStates;
};

const parseWorkspaceId = (workspaceId) => {
  if (!workspaceId) return null;
  if (!mongoose.Types.ObjectId.isValid(workspaceId)) {
    throw new AppError('Invalid workspaceId.', 400);
  }
  return new mongoose.Types.ObjectId(workspaceId);
};

const ensureReportingAccess = async (req, workspaceId) => {
  if (isEnterpriseAdmin(req.user)) {
    return null;
  }

  if (!isWorkspaceManager(req.user)) {
    throw new AppError('You do not have permission to view asset analytics.', 403);
  }

  if (!workspaceId) {
    return null;
  }

  const workspace = await Workspace.findOne({ _id: workspaceId, tenantId: req.user.tenantId });
  if (!workspace) {
    throw new AppError('Workspace not found.', 404);
  }

  if (!canManageWorkspace(req, workspace)) {
    throw new AppError('You do not have permission to view this workspace report.', 403);
  }

  return workspace;
};

const buildAssetMatch = ({ tenantId, workspaceId, startDate, endDate, lifecycleStates }) => {
  const match = {
    tenantId,
    isDeleted: false,
  };

  if (workspaceId) {
    match.workspaceId = workspaceId;
  }

  if (Array.isArray(lifecycleStates) && lifecycleStates.length > 0) {
    match.lifecycleState = { $in: lifecycleStates };
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

const buildBottleneckPipeline = ({ tenantId, workspaceId, startDate, endDate, lifecycleStates = BOTTLENECK_STATES }) => ([
  {
    $match: buildAssetMatch({
      tenantId,
      workspaceId,
      startDate,
      endDate,
      lifecycleStates,
    }),
  },
  {
    $group: {
      _id: '$lifecycleState',
      count: { $sum: 1 },
    },
  },
]);

const buildStorageProfilePipeline = ({ tenantId, workspaceId, startDate, endDate, lifecycleStates = STORAGE_STATES }) => ([
  {
    $match: buildAssetMatch({
      tenantId,
      workspaceId,
      startDate,
      endDate,
      lifecycleStates,
    }),
  },
  {
    $group: {
      _id: {
        extension: { $ifNull: ['$fileExtension', 'unknown'] },
        mimeType: { $ifNull: ['$mimeType', 'application/octet-stream'] },
      },
      count: { $sum: 1 },
      totalSize: { $sum: { $ifNull: ['$fileSize', 0] } },
    },
  },
  {
    $sort: { totalSize: -1, count: -1 },
  },
]);

const mergeByKey = (rows, keyResolver) => {
  const map = new Map();

  rows.forEach((row) => {
    const key = keyResolver(row);
    if (!key) return;
    const current = map.get(key) || { key, count: 0, totalSize: 0 };
    current.count += Number(row.count || 0);
    current.totalSize += Number(row.totalSize || 0);
    current.mimeType = current.mimeType || row._id?.mimeType || row.mimeType;
    current.fileExtension = current.fileExtension || row._id?.extension || row.fileExtension;
    map.set(key, current);
  });

  return [...map.values()].sort((a, b) => b.totalSize - a.totalSize || b.count - a.count);
};

const buildWorkspaceAssetReport = async (req) => {
  const workspaceId = req.query.workspaceId ? parseWorkspaceId(req.query.workspaceId) : null;
  const { startDate, endDate, period } = parseReportWindow(req);
  const lifecycleStates = parseLifecycleStateFilter(req.query.state || req.query.states);

  await ensureReportingAccess(req, workspaceId);

  const reportMatch = {
    tenantId: req.user.tenantId,
    workspaceId,
    startDate,
    endDate,
    lifecycleStates,
  };

  const [documentBottlenecks, videoBottlenecks, documentStorage, videoStorage, leaderboard] = await Promise.all([
    Document.aggregate(buildBottleneckPipeline(reportMatch)),
    Video.aggregate(buildBottleneckPipeline(reportMatch)),
    Document.aggregate(buildStorageProfilePipeline(reportMatch)),
    Video.aggregate(buildStorageProfilePipeline(reportMatch)),
    ActivityLog.aggregate([
      {
        $match: {
          tenantId: req.user.tenantId,
          ...(workspaceId ? { workspaceId } : {}),
          action: 'STATE_CHANGE',
          ...(Array.isArray(lifecycleStates) && lifecycleStates.length > 0 ? { newState: { $in: lifecycleStates } } : { newState: 'FINISHED' }),
          timestamp: {
            $gte: startDate,
            $lte: endDate,
          },
        },
      },
      {
        $group: {
          _id: '$userId',
          completedCount: { $sum: 1 },
          lastCompletedAt: { $max: '$timestamp' },
        },
      },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user',
        },
      },
      {
        $unwind: {
          path: '$user',
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $project: {
          userId: '$_id',
          completedCount: 1,
          lastCompletedAt: 1,
          firstName: '$user.firstName',
          lastName: '$user.lastName',
          email: '$user.email',
          displayName: {
            $trim: {
              input: {
                $concat: [
                  { $ifNull: ['$user.firstName', ''] },
                  ' ',
                  { $ifNull: ['$user.lastName', ''] },
                ],
              },
            },
          },
        },
      },
      {
        $sort: { completedCount: -1, lastCompletedAt: -1 },
      },
    ]),
  ]);

  const bottleneckRows = [...documentBottlenecks, ...videoBottlenecks];
  const bottleneckTotals = ['STARTED', 'IN_PROGRESS', 'NEEDS_REVIEW', 'REJECTED'].reduce((acc, state) => {
    acc[state] = bottleneckRows
      .filter((row) => row._id === state)
      .reduce((total, row) => total + Number(row.count || 0), 0);
    return acc;
  }, {});

  const storageProfileByExtension = mergeByKey([...documentStorage, ...videoStorage], (row) => row._id?.extension || 'unknown');
  const storageProfileByMimeType = mergeByKey([...documentStorage, ...videoStorage], (row) => row._id?.mimeType || 'application/octet-stream');

  return {
    filters: {
      tenantId: req.user.tenantId,
      workspaceId: workspaceId ? workspaceId.toString() : null,
      startDate,
      endDate,
      period,
      lifecycleStates,
    },
    bottlenecks: bottleneckTotals,
    teamFinalizationLeaderboard: leaderboard,
    storageProfile: {
      byExtension: storageProfileByExtension,
      byMimeType: storageProfileByMimeType,
    },
  };
};

exports.updateAssetLifecycleState = catchAsync(async (req, res, next) => {
  const { type, id } = req.params;
  const { lifecycleState } = req.body;

  if (!assetModels[type]) {
    return next(new AppError('Invalid asset type. Use document or video.', 400));
  }

  if (!LIFECYCLE_STATES.includes(lifecycleState)) {
    return next(new AppError('Invalid lifecycle state.', 400));
  }

  const asset = await assetModels[type].findOne({
    _id: id,
    tenantId: req.user.tenantId,
    isDeleted: false,
  });

  if (!asset) {
    return next(new AppError('Asset not found.', 404));
  }

  if (!asset.hasAccess(req.user._id, 'edit')) {
    return next(new AppError('You do not have permission to update this asset.', 403));
  }

  const previousState = asset.lifecycleState || 'STARTED';
  asset.lifecycleState = lifecycleState;
  asset.$locals.currentUser = req.user;
  asset.$locals.assetActivity = {
    action: 'STATE_CHANGE',
    previousState,
    newState: lifecycleState,
  };

  await asset.save();

  res.status(200).json({
    status: 'success',
    data: {
      asset,
    },
  });
});

exports.getWorkspaceAssetReport = catchAsync(async (req, res, next) => {
  const report = await buildWorkspaceAssetReport(req);

  res.status(200).json({
    status: 'success',
    data: report,
  });
});

exports.exportWorkspaceAssetReport = catchAsync(async (req, res, next) => {
  const report = await buildWorkspaceAssetReport(req);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'GravySyncro';
  workbook.created = new Date();

  const formatValue = (value) => {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  };

  const selectedStates = Array.isArray(report.filters.lifecycleStates) && report.filters.lifecycleStates.length > 0
    ? report.filters.lifecycleStates.join(', ')
    : 'All';

  const overviewSheet = workbook.addWorksheet('Overview');
  overviewSheet.columns = [
    { header: 'Metric', key: 'metric', width: 32 },
    { header: 'Value', key: 'value', width: 24 },
  ];
  overviewSheet.addRows([
    { metric: 'Tenant ID', value: report.filters.tenantId },
    { metric: 'Workspace ID', value: report.filters.workspaceId || 'All' },
    { metric: 'Period', value: report.filters.period || 'Custom' },
    { metric: 'States', value: selectedStates },
    { metric: 'Start Date', value: formatValue(report.filters.startDate) },
    { metric: 'End Date', value: formatValue(report.filters.endDate) },
    { metric: 'STARTED', value: report.bottlenecks.STARTED || 0 },
    { metric: 'IN_PROGRESS', value: report.bottlenecks.IN_PROGRESS || 0 },
    { metric: 'NEEDS_REVIEW', value: report.bottlenecks.NEEDS_REVIEW || 0 },
    { metric: 'REJECTED', value: report.bottlenecks.REJECTED || 0 },
  ]);

  const leaderboardSheet = workbook.addWorksheet('Leaderboard');
  leaderboardSheet.columns = [
    { header: 'User', key: 'displayName', width: 32 },
    { header: 'Email', key: 'email', width: 32 },
    { header: 'Finished Assets', key: 'completedCount', width: 18 },
    { header: 'Last Finished At', key: 'lastCompletedAt', width: 24 },
  ];
  leaderboardSheet.addRows(report.teamFinalizationLeaderboard.map((row) => ({
    displayName: row.displayName || 'Unknown User',
    email: row.email || '',
    completedCount: row.completedCount || 0,
    lastCompletedAt: row.lastCompletedAt ? new Date(row.lastCompletedAt).toISOString() : '',
  })));

  const storageSheet = workbook.addWorksheet('Storage Profile');
  storageSheet.columns = [
    { header: 'File Extension', key: 'fileExtension', width: 20 },
    { header: 'MIME Type', key: 'mimeType', width: 28 },
    { header: 'Asset Count', key: 'count', width: 14 },
    { header: 'Total Size (Bytes)', key: 'totalSize', width: 18 },
  ];
  storageSheet.addRows(report.storageProfile.byExtension.map((row) => ({
    fileExtension: row.fileExtension || row.key || 'unknown',
    mimeType: row.mimeType || '',
    count: row.count || 0,
    totalSize: row.totalSize || 0,
  })));

  const mimeTypeSheet = workbook.addWorksheet('Storage by MIME Type');
  mimeTypeSheet.columns = [
    { header: 'MIME Type', key: 'mimeType', width: 32 },
    { header: 'Asset Count', key: 'count', width: 14 },
    { header: 'Total Size (Bytes)', key: 'totalSize', width: 18 },
  ];
  mimeTypeSheet.addRows(report.storageProfile.byMimeType.map((row) => ({
    mimeType: row.mimeType || row.key || 'application/octet-stream',
    count: row.count || 0,
    totalSize: row.totalSize || 0,
  })));

  const bottleneckSheet = workbook.addWorksheet('Bottlenecks');
  bottleneckSheet.columns = [
    { header: 'State', key: 'state', width: 20 },
    { header: 'Count', key: 'count', width: 14 },
  ];
  bottleneckSheet.addRows([
    { state: 'STARTED', count: report.bottlenecks.STARTED || 0 },
    { state: 'IN_PROGRESS', count: report.bottlenecks.IN_PROGRESS || 0 },
    { state: 'NEEDS_REVIEW', count: report.bottlenecks.NEEDS_REVIEW || 0 },
    { state: 'REJECTED', count: report.bottlenecks.REJECTED || 0 },
  ]);

  const buffer = await workbook.xlsx.writeBuffer();
  const fileName = `gravy-syncro-asset-report-${new Date().toISOString().replace(/[:.]/g, '-')}.xlsx`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.status(200).send(Buffer.from(buffer));
});