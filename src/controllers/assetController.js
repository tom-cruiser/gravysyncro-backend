const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const mongoose = require('mongoose');

const Document = require('../models/Document');
const Video = require('../models/Video');
const Audio = require('../models/Audio');
const Workspace = require('../models/Workspace');
const ActivityLog = require('../models/ActivityLog');
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const { canManageWorkspace, isEnterpriseAdmin, isWorkspaceManager } = require('../utils/workspaceAccess');
const { LIFECYCLE_STATES } = require('../utils/assetLifecycle');

const assetModels = {
  document: Document,
  video: Video,
  audio: Audio,
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

const ASSET_TYPE_ALIASES = {
  document: 'document',
  documents: 'document',
  file: 'document',
  files: 'document',
  video: 'video',
  videos: 'video',
  audio: 'audio',
  audios: 'audio',
};

// Which page/tab a report was generated from. Returning null means "all" —
// used by the admin-wide overview, which isn't scoped to a single asset type.
const parseAssetTypeFilter = (value) => {
  if (!value || value === 'all') {
    return null;
  }

  const normalized = ASSET_TYPE_ALIASES[String(value).toLowerCase()];
  if (!normalized) {
    throw new AppError('Invalid asset type filter. Use "document", "video", "audio", or "all".', 400);
  }

  return normalized;
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
  const assetType = parseAssetTypeFilter(req.query.assetType || req.query.type);

  await ensureReportingAccess(req, workspaceId);

  const reportMatch = {
    tenantId: req.user.tenantId,
    workspaceId,
    startDate,
    endDate,
    lifecycleStates,
  };

  // null assetType means "all" (the admin-wide overview) — include every type.
  const includeDocuments = !assetType || assetType === 'document';
  const includeVideos = !assetType || assetType === 'video';
  const includeAudio = !assetType || assetType === 'audio';
  const emptyAggregate = Promise.resolve([]);
  const ASSET_TYPE_TO_ACTIVITY_LOG_LABEL = { video: 'Video', audio: 'Audio', document: 'Document' };

  const [documentBottlenecks, videoBottlenecks, audioBottlenecks, documentStorage, videoStorage, audioStorage, leaderboard] = await Promise.all([
    includeDocuments ? Document.aggregate(buildBottleneckPipeline(reportMatch)) : emptyAggregate,
    includeVideos ? Video.aggregate(buildBottleneckPipeline(reportMatch)) : emptyAggregate,
    includeAudio ? Audio.aggregate(buildBottleneckPipeline(reportMatch)) : emptyAggregate,
    includeDocuments ? Document.aggregate(buildStorageProfilePipeline(reportMatch)) : emptyAggregate,
    includeVideos ? Video.aggregate(buildStorageProfilePipeline(reportMatch)) : emptyAggregate,
    includeAudio ? Audio.aggregate(buildStorageProfilePipeline(reportMatch)) : emptyAggregate,
    ActivityLog.aggregate([
      {
        $match: {
          tenantId: req.user.tenantId,
          ...(workspaceId ? { workspaceId } : {}),
          action: 'STATE_CHANGE',
          ...(assetType ? { assetType: ASSET_TYPE_TO_ACTIVITY_LOG_LABEL[assetType] } : {}),
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

  const bottleneckRows = [...documentBottlenecks, ...videoBottlenecks, ...audioBottlenecks];
  const bottleneckTotals = ['STARTED', 'IN_PROGRESS', 'NEEDS_REVIEW', 'REJECTED'].reduce((acc, state) => {
    acc[state] = bottleneckRows
      .filter((row) => row._id === state)
      .reduce((total, row) => total + Number(row.count || 0), 0);
    return acc;
  }, {});

  const storageProfileByExtension = mergeByKey([...documentStorage, ...videoStorage, ...audioStorage], (row) => row._id?.extension || 'unknown');
  const storageProfileByMimeType = mergeByKey([...documentStorage, ...videoStorage, ...audioStorage], (row) => row._id?.mimeType || 'application/octet-stream');

  return {
    filters: {
      tenantId: req.user.tenantId,
      workspaceId: workspaceId ? workspaceId.toString() : null,
      startDate,
      endDate,
      period,
      lifecycleStates,
      assetType,
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
    return next(new AppError('Invalid asset type. Use document, video, or audio.', 400));
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

const formatAssetTypeLabel = (assetType) => {
  if (assetType === 'document') return 'Documents only';
  if (assetType === 'video') return 'Videos only';
  if (assetType === 'audio') return 'Audio only';
  return 'Documents, Videos & Audio';
};

const buildAssetReportWorkbook = (report) => {
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
    { metric: 'Asset Type', value: formatAssetTypeLabel(report.filters.assetType) },
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

  return workbook;
};

const formatBytesForDisplay = (bytes) => {
  const value = Number(bytes) || 0;
  if (value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const size = value / Math.pow(1024, exponent);
  return `${size.toFixed(size >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
};

const formatDateForDisplay = (value) => {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString().slice(0, 10);
};

/**
 * Renders a simple bordered table starting at the document's current
 * vertical position, adding pages as needed. Returns the y position
 * after the table.
 */
const drawPdfTable = (doc, { headers, rows, columnWidths, title }) => {
  const startX = doc.page.margins.left;
  const pageBottom = doc.page.height - doc.page.margins.bottom;
  const rowHeight = 20;

  if (title) {
    if (doc.y + 24 > pageBottom) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#111827').text(title, startX, doc.y);
    doc.moveDown(0.4);
  }

  const drawHeaderRow = () => {
    let x = startX;
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff');
    doc.rect(startX, y, columnWidths.reduce((a, b) => a + b, 0), rowHeight).fill('#4f46e5');
    doc.fillColor('#ffffff');
    headers.forEach((header, i) => {
      doc.text(String(header), x + 4, y + 6, { width: columnWidths[i] - 8, ellipsis: true });
      x += columnWidths[i];
    });
    doc.y = y + rowHeight;
  };

  drawHeaderRow();

  doc.font('Helvetica').fontSize(9).fillColor('#111827');

  if (!rows.length) {
    if (doc.y + rowHeight > pageBottom) doc.addPage();
    doc.text('No data available', startX + 4, doc.y + 6);
    doc.y += rowHeight;
  }

  rows.forEach((row, rowIndex) => {
    if (doc.y + rowHeight > pageBottom) {
      doc.addPage();
      drawHeaderRow();
      doc.font('Helvetica').fontSize(9).fillColor('#111827');
    }

    let x = startX;
    const y = doc.y;
    if (rowIndex % 2 === 1) {
      doc.rect(startX, y, columnWidths.reduce((a, b) => a + b, 0), rowHeight).fill('#f3f4f6');
      doc.fillColor('#111827');
    }
    row.forEach((cell, i) => {
      doc.text(String(cell ?? ''), x + 4, y + 6, { width: columnWidths[i] - 8, ellipsis: true });
      x += columnWidths[i];
    });
    doc.y = y + rowHeight;
  });

  doc.moveDown(1);
};

const buildAssetReportPdfBuffer = (report) => new Promise((resolve, reject) => {
  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  const chunks = [];

  doc.on('data', (chunk) => chunks.push(chunk));
  doc.on('end', () => resolve(Buffer.concat(chunks)));
  doc.on('error', reject);

  const selectedStates = Array.isArray(report.filters.lifecycleStates) && report.filters.lifecycleStates.length > 0
    ? report.filters.lifecycleStates.join(', ')
    : 'All';

  doc.font('Helvetica-Bold').fontSize(20).fillColor('#111827').text('GravySyncro Asset Report');
  doc.font('Helvetica').fontSize(10).fillColor('#6b7280')
    .text(`Generated ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC`);
  doc.moveDown(1);

  drawPdfTable(doc, {
    title: 'Overview',
    headers: ['Metric', 'Value'],
    columnWidths: [180, 300],
    rows: [
      ['Tenant ID', report.filters.tenantId],
      ['Workspace ID', report.filters.workspaceId || 'All'],
      ['Asset Type', formatAssetTypeLabel(report.filters.assetType)],
      ['Period', report.filters.period || 'Custom'],
      ['States', selectedStates],
      ['Start Date', formatDateForDisplay(report.filters.startDate)],
      ['End Date', formatDateForDisplay(report.filters.endDate)],
      ['Started', report.bottlenecks.STARTED || 0],
      ['In Progress', report.bottlenecks.IN_PROGRESS || 0],
      ['Needs Review', report.bottlenecks.NEEDS_REVIEW || 0],
      ['Rejected', report.bottlenecks.REJECTED || 0],
    ],
  });

  drawPdfTable(doc, {
    title: 'Team Finalization Leaderboard',
    headers: ['User', 'Email', 'Finished Assets', 'Last Finished At'],
    columnWidths: [130, 160, 90, 100],
    rows: report.teamFinalizationLeaderboard.map((row) => [
      row.displayName || 'Unknown User',
      row.email || '',
      row.completedCount || 0,
      formatDateForDisplay(row.lastCompletedAt),
    ]),
  });

  drawPdfTable(doc, {
    title: 'Storage Profile by File Extension',
    headers: ['Extension', 'MIME Type', 'Count', 'Total Size'],
    columnWidths: [90, 190, 70, 130],
    rows: report.storageProfile.byExtension.map((row) => [
      row.fileExtension || row.key || 'unknown',
      row.mimeType || '',
      row.count || 0,
      formatBytesForDisplay(row.totalSize),
    ]),
  });

  drawPdfTable(doc, {
    title: 'Storage Profile by MIME Type',
    headers: ['MIME Type', 'Count', 'Total Size'],
    columnWidths: [220, 90, 130],
    rows: report.storageProfile.byMimeType.map((row) => [
      row.mimeType || row.key || 'application/octet-stream',
      row.count || 0,
      formatBytesForDisplay(row.totalSize),
    ]),
  });

  doc.end();
});

exports.exportWorkspaceAssetReport = catchAsync(async (req, res, next) => {
  const report = await buildWorkspaceAssetReport(req);
  const format = String(req.query.format || 'xlsx').toLowerCase();

  if (!['xlsx', 'pdf'].includes(format)) {
    return next(new AppError('Invalid report format. Choose "xlsx" or "pdf".', 400));
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  if (format === 'pdf') {
    const buffer = await buildAssetReportPdfBuffer(report);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="gravy-syncro-asset-report-${timestamp}.pdf"`);
    return res.status(200).send(buffer);
  }

  const workbook = buildAssetReportWorkbook(report);
  const buffer = await workbook.xlsx.writeBuffer();

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="gravy-syncro-asset-report-${timestamp}.xlsx"`);
  res.status(200).send(Buffer.from(buffer));
});