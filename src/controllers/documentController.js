const Document = require('../models/Document');
const User = require('../models/User');
const Workspace = require('../models/Workspace');
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const { uploadFile, downloadFile, deleteFile, getSignedUrl } = require('../config/wasabi');
const { emitTenantEvent } = require('../config/socket');
const { log } = require('../middleware/activityLogger');
const { sendDocumentSharedEmail } = require('../services/emailService');
const { createNotification } = require('./notificationController');
const { getTenantStorageSummary } = require('../utils/tenantStorage');
const { gbToBytes } = require('../utils/storagePlans');
const sharp = require('sharp');
const {
  isEnterpriseAdmin,
  canWriteWorkspace,
  getAccessibleWorkspaceIds,
  canViewWorkspaceDocument,
  canMutateWorkspaceDocument,
} = require('../utils/workspaceAccess');

const isLikelyPdfBuffer = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return false;
  const headerScan = buffer.subarray(0, Math.min(buffer.length, 1024)).toString('latin1');
  return headerScan.includes('%PDF-');
};

const getWorkspaceParticipantIds = (workspace) => {
  const ids = new Set();
  if (!workspace) return [];
  if (workspace.manager) ids.add(workspace.manager.toString());
  (workspace.members || []).forEach((member) => ids.add(member.user.toString()));
  (workspace.guests || []).forEach((guest) => ids.add(guest.user.toString()));
  return [...ids];
};

const ensureWorkspaceWritable = async (req, workspaceId) => {
  if (!workspaceId) return null;

  const workspace = await Workspace.findOne({ _id: workspaceId, tenantId: req.user.tenantId });
  if (!workspace) {
    throw new AppError('Workspace not found', 404);
  }

  const canWrite = await canWriteWorkspace(req, workspaceId);

  if (!canWrite) {
    throw new AppError('You do not have access to this workspace', 403);
  }

  if (workspace.status === 'archived' && !workspace.reworkEnabled) {
    throw new AppError('This workspace is archived and read-only', 403);
  }

  return workspace;
};

const escapeRegExp = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Upload document
 */
exports.uploadDocument = catchAsync(async (req, res, next) => {
  if (!req.file) {
    return next(new AppError('Please provide a file to upload', 400));
  }

  if (!Buffer.isBuffer(req.file.buffer) || req.file.buffer.length === 0) {
    return next(new AppError('Uploaded file is empty or invalid. Please try again.', 400));
  }

  if (req.file.mimetype === 'application/pdf') {
    if (!isLikelyPdfBuffer(req.file.buffer)) {
      return next(new AppError('Invalid PDF file content. Please upload a valid PDF document.', 400));
    }
  }

  const { name, title, description, type, category, tags, folderId, folderPath, relativePath, workspaceId } = req.body;

  const normalizePath = (value = '') =>
    String(value)
      .replace(/\\/g, '/')
      .split('/')
      .filter(Boolean)
      .join('/');

  const normalizedFolderPath = normalizePath(folderPath);
  const folderName = normalizedFolderPath ? normalizedFolderPath.split('/').pop() : 'root';
  const pathValue = normalizedFolderPath ? `/${normalizedFolderPath}` : '/';

  const workspace = await ensureWorkspaceWritable(req, workspaceId);

  const resolvedOriginalName = String(req.file.originalname || '').trim() || 'untitled';
  const resolvedWorkspaceId = workspace ? workspace._id : workspaceId || null;

  const normalizedRelativePath = normalizePath(relativePath) ||
    (normalizedFolderPath ? `${normalizedFolderPath}/${resolvedOriginalName}` : resolvedOriginalName);

  // Process image if it's an image
  let fileBuffer = req.file.buffer;
  if (req.file.mimetype.startsWith('image/')) {
    try {
      fileBuffer = await sharp(req.file.buffer)
        .resize(2000, 2000, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 90 })
        .toBuffer();
    } catch (sharpError) {
      return next(new AppError(`Image processing failed: ${sharpError.message}`, 400));
    }
  }

  const [latestUser, tenantStorage] = await Promise.all([
    User.findById(req.user._id).select('storageUsed storageLimit'),
    getTenantStorageSummary(req.user.tenantId),
  ]);
  if (!latestUser) {
    return next(new AppError('User not found', 404));
  }

  const fileSizeBytes = fileBuffer.length;
  const projectedUsage = Number(tenantStorage.storageUsed || 0) + fileSizeBytes;
  if (projectedUsage > Number(tenantStorage.storageLimit || 0)) {
    const availableBytes = Math.max(Number(tenantStorage.storageLimit || 0) - Number(tenantStorage.storageUsed || 0), 0);
    return next(
      new AppError(
        `Enterprise storage limit reached. Available space: ${(availableBytes / (1024 * 1024)).toFixed(2)} MB. Please ask your admin to upgrade the enterprise plan.`,
        403
      )
    );
  }

  // Upload to Wasabi
  const fileKey = `${req.user.tenantId}/documents/${Date.now()}-${resolvedOriginalName}`;
  try {
    await uploadFile(fileKey, fileBuffer, req.file.mimetype);
  } catch (wasabiError) {
    if (wasabiError.code === 'Forbidden' || wasabiError.code === 'AccessDenied') {
      return next(new AppError('Storage service permission denied. Please verify Wasabi credentials.', 503));
    }
    if (wasabiError.code === 'NoSuchBucket') {
      return next(new AppError('Storage bucket not found. Please verify bucket configuration.', 503));
    }
    // Re-throw for generic error handler
    throw wasabiError;
  }

  const existingDocument = await Document.findOne({
    tenantId: req.user.tenantId,
    workspaceId: resolvedWorkspaceId || null,
    folderPath: normalizedFolderPath,
    originalName: { $regex: `^${escapeRegExp(resolvedOriginalName)}$`, $options: 'i' },
    isDeleted: false,
  });

  const fileExtension = resolvedOriginalName.includes('.')
    ? resolvedOriginalName.split('.').pop().toLowerCase()
    : 'bin';

  const parsedTags = tags ? tags.split(',').map((tag) => tag.trim()).filter(Boolean) : [];

  let document;
  let wasVersionUpload = false;

  if (existingDocument) {
    wasVersionUpload = true;

    if (!Array.isArray(existingDocument.versions)) {
      existingDocument.versions = [];
    }
    if (!Array.isArray(existingDocument.versionHistory)) {
      existingDocument.versionHistory = [];
    }

    if (existingDocument.versions.length === 0 && existingDocument.fileKey) {
      existingDocument.versions.push({
        version: Number(existingDocument.version) || 1,
        fileKey: existingDocument.fileKey,
        size: Number(existingDocument.fileSize || existingDocument.size) || 0,
        uploadedBy: existingDocument.uploadedBy || existingDocument.owner,
        uploadedAt: existingDocument.updatedAt || existingDocument.createdAt || new Date(),
        changes: 'Initial upload',
      });
    }

    const maxVersionFromArray = existingDocument.versions.reduce(
      (max, current) => Math.max(max, Number(current?.version) || 0),
      0,
    );
    const nextVersion = Math.max(Number(existingDocument.version) || 0, maxVersionFromArray) + 1;

    existingDocument.version = nextVersion;
    existingDocument.uploadedBy = req.user._id;
    existingDocument.fileName = resolvedOriginalName;
    existingDocument.filename = resolvedOriginalName;
    existingDocument.fileExtension = fileExtension;
    existingDocument.fileSize = fileSizeBytes;
    existingDocument.size = fileSizeBytes;
    existingDocument.storageKey = fileKey;
    existingDocument.fileKey = fileKey;
    existingDocument.mimeType = req.file.mimetype;
    existingDocument.checksum = `${Date.now()}-${fileSizeBytes}`;
    existingDocument.folder = folderName;
    existingDocument.path = pathValue;
    existingDocument.folderPath = normalizedFolderPath;
    existingDocument.relativePath = normalizedRelativePath;

    if (title || name) {
      existingDocument.title = title || name || existingDocument.title;
      existingDocument.name = name || title || existingDocument.name;
    }
    if (typeof description === 'string') {
      existingDocument.description = description;
    }
    if (type || category) {
      existingDocument.type = type || category || existingDocument.type;
      existingDocument.category = category || existingDocument.category;
    }
    if (parsedTags.length > 0) {
      existingDocument.tags = parsedTags;
    }
    if (folderId !== undefined) {
      existingDocument.folderId = folderId;
    }

    existingDocument.versions.push({
      version: nextVersion,
      fileKey,
      size: fileSizeBytes,
      uploadedBy: req.user._id,
      uploadedAt: Date.now(),
      changes: `Uploaded new version (v${nextVersion})`,
    });

    existingDocument.versionHistory.push({
      version: nextVersion,
      storageKey: fileKey,
      updatedBy: req.user._id,
      updatedAt: Date.now(),
      changes: `Uploaded new version (v${nextVersion})`,
      fileSize: fileSizeBytes,
    });

    existingDocument.$locals.currentUser = req.user;
    existingDocument.$locals.assetActivity = {
      action: 'UPLOAD',
      previousState: existingDocument.lifecycleState || 'STARTED',
      newState: existingDocument.lifecycleState || 'STARTED',
      details: {
        version: nextVersion,
      },
    };

    document = await existingDocument.save();
  } else {
    // Create document record
    document = new Document({
      tenantId: req.user.tenantId,
      owner: req.user._id,
      uploadedBy: req.user._id,
      title: title || name || resolvedOriginalName,
      name: name || title || resolvedOriginalName,
      description,
      type: type || category || 'General',
      fileName: resolvedOriginalName,
      originalName: resolvedOriginalName,
      fileSize: fileSizeBytes,
      fileExtension,
      storageKey: fileKey,
      checksum: `${Date.now()}-${fileSizeBytes}`,
      filename: resolvedOriginalName,
      fileKey,
      mimeType: req.file.mimetype,
      size: fileSizeBytes,
      category,
      tags: parsedTags,
      folderId,
      workspaceId: resolvedWorkspaceId,
      folder: folderName,
      path: pathValue,
      folderPath: normalizedFolderPath,
      relativePath: normalizedRelativePath,
      versions: [{
        version: 1,
        fileKey,
        size: fileSizeBytes,
        uploadedBy: req.user._id,
        uploadedAt: Date.now(),
        changes: 'Initial upload',
      }],
      versionHistory: [{
        version: 1,
        storageKey: fileKey,
        updatedBy: req.user._id,
        updatedAt: Date.now(),
        changes: 'Initial upload',
        fileSize: fileSizeBytes,
      }],
    });

    document.$locals.currentUser = req.user;
    document.$locals.assetActivity = {
      action: 'UPLOAD',
      previousState: null,
      newState: document.lifecycleState,
      details: {
        version: 1,
      },
    };

    await document.save();
  }

  await User.findByIdAndUpdate(req.user._id, {
    $inc: { storageUsed: fileSizeBytes },
  });

  // Log activity
  await log(req, wasVersionUpload ? 'document_upload_version' : 'document_upload', 'document', document._id, {
    documentName: document.name,
    version: document.version || 1,
  });

  if (workspace) {
    const participants = getWorkspaceParticipantIds(workspace).filter((userId) => userId !== req.user._id.toString());
    await Promise.all(participants.map((userId) => createNotification({
      tenantId: req.user.tenantId,
      user: userId,
      type: 'workspace_uploaded',
      title: wasVersionUpload ? 'New file version uploaded' : 'New file uploaded',
      message: wasVersionUpload
        ? `${document.name} received a new version in ${workspace.name}`
        : `${document.name} was uploaded to ${workspace.name}`,
      relatedDocument: document._id,
      relatedWorkspace: workspace._id,
      actionUrl: `/documents?view=${document._id}`,
    })));
  }

  res.status(wasVersionUpload ? 200 : 201).json({
    status: 'success',
    message: wasVersionUpload ? 'Document version uploaded successfully' : 'Document uploaded successfully',
    data: {
      document,
      versioned: wasVersionUpload,
    },
  });
});

/**
 * Get all documents
 */
exports.getAllDocuments = catchAsync(async (req, res, next) => {
  const {
    page = 1,
    limit = 20,
    search,
    category,
    tags,
    uploadedBy,
    folderId,
    sortBy = '-createdAt',
  } = req.query;

  // Build query
  const query = {
    tenantId: req.user.tenantId,
    isDeleted: false,
  };

  const accessibleWorkspaceIds = await getAccessibleWorkspaceIds(req);

  // Search
  if (search) {
    query.$or = [
      { name: { $regex: search, $options: 'i' } },
      { description: { $regex: search, $options: 'i' } },
      { tags: { $regex: search, $options: 'i' } },
    ];
  }

  // Filter by category
  if (category) {
    query.category = category;
  }

  if (req.query.workspaceId) {
    query.workspaceId = req.query.workspaceId;
  }

  // Filter by tags
  if (tags) {
    query.tags = { $in: tags.split(',') };
  }

  // Filter by uploader
  if (uploadedBy) {
    query.uploadedBy = uploadedBy;
  }

  // Filter by folder
  if (folderId === 'null') {
    query.folderId = null;
  } else if (folderId) {
    query.folderId = folderId;
  }

  // Check permissions
  if (!isEnterpriseAdmin(req.user)) {
    const workspaceScope = accessibleWorkspaceIds && accessibleWorkspaceIds.length > 0
      ? [{ workspaceId: { $in: accessibleWorkspaceIds } }]
      : [];

    query.$or = [
      { uploadedBy: req.user._id },
      { owner: req.user._id },
      { 'sharedWith.user': req.user._id },
      { visibility: 'public' },
      ...workspaceScope,
    ];
  }

  // Execute query
  const documents = await Document.find(query)
    .populate('uploadedBy', 'firstName lastName email')
    .populate('sharedWith.user', 'firstName lastName email')
    .sort(sortBy)
    .limit(limit * 1)
    .skip((page - 1) * limit);

  // Get total count
  const total = await Document.countDocuments(query);

  res.status(200).json({
    status: 'success',
    results: documents.length,
    total,
    page: parseInt(page),
    pages: Math.ceil(total / limit),
    data: {
      documents,
    },
  });
});

/**
 * Get document by ID
 */
exports.getDocument = catchAsync(async (req, res, next) => {
  const document = await Document.findOne({
    _id: req.params.id,
    tenantId: req.user.tenantId,
    isDeleted: false,
  })
    .populate('uploadedBy', 'firstName lastName email')
    .populate('sharedWith.user', 'firstName lastName email')
    .populate('accessLog.user', 'firstName lastName email');

  if (!document) {
    return next(new AppError(`Document with ID "${req.params.id}" not found. It may have been deleted.`, 404));
  }

  // Check permissions
  const canView = document.canUserAccess(req.user._id, 'view') || await canViewWorkspaceDocument(req, document);
  if (!canView) {
    return next(new AppError('You do not have permission to view this document', 403));
  }

  // Log access
  await document.logAccess(req.user._id, 'view');

  res.status(200).json({
    status: 'success',
    data: {
      document,
    },
  });
});

/**
 * Update document
 */
exports.updateDocument = catchAsync(async (req, res, next) => {
  const { name, description, category, tags, folderId, visibility } = req.body;

  const document = await Document.findOne({
    _id: req.params.id,
    tenantId: req.user.tenantId,
    isDeleted: false,
  });

  if (!document) {
    return next(new AppError(`Document with ID "${req.params.id}" not found. It may have been deleted.`, 404));
  }

  // Check permissions
  const canEdit = document.canUserAccess(req.user._id, 'edit') || await canMutateWorkspaceDocument(req, document);
  if (!canEdit) {
    return next(new AppError('You do not have permission to edit this document', 403));
  }

  if (document.workspaceId) {
    const workspace = await Workspace.findOne({ _id: document.workspaceId, tenantId: req.user.tenantId });
    if (workspace && workspace.status === 'archived' && !workspace.reworkEnabled) {
      return next(new AppError('This workspace is archived and read-only', 403));
    }
  }

  // Update fields
  if (name) document.name = name;
  if (description) document.description = description;
  if (category) document.category = category;
  if (tags) document.tags = tags.split(',').map(tag => tag.trim());
  if (folderId !== undefined) document.folderId = folderId;
  if (visibility) document.visibility = visibility;

  document.$locals.currentUser = req.user;

  await document.save();

  // Log activity
  await log(req, 'document_update', 'document', document._id, { documentName: document.name });

  res.status(200).json({
    status: 'success',
    data: {
      document,
    },
  });
});

/**
 * Delete document (soft delete)
 */
exports.deleteDocument = catchAsync(async (req, res, next) => {
  const document = await Document.findOne({
    _id: req.params.id,
    tenantId: req.user.tenantId,
    isDeleted: false,
  });

  if (!document) {
    return next(new AppError(`Document with ID "${req.params.id}" not found or already deleted.`, 404));
  }

  // Check permissions
  const canDelete = document.canUserAccess(req.user._id, 'delete') || await canMutateWorkspaceDocument(req, document);
  if (!canDelete) {
    return next(new AppError('You do not have permission to delete this document', 403));
  }

  if (document.workspaceId) {
    const workspace = await Workspace.findOne({ _id: document.workspaceId, tenantId: req.user.tenantId });
    if (workspace && workspace.status === 'archived' && !workspace.reworkEnabled) {
      return next(new AppError('This workspace is archived and read-only', 403));
    }
  }

  // Soft delete
  document.isDeleted = true;
  document.deletedAt = Date.now();
  document.deletedBy = req.user._id;
  document.$locals.currentUser = req.user;
  await document.save();

  // Log activity
  await log(req, 'document_delete', 'document', document._id, { documentName: document.name });

  emitTenantEvent(req.user.tenantId, 'document:deleted', {
    documentId: document._id.toString(),
    workspaceId: document.workspaceId ? document.workspaceId.toString() : null,
    folderPath: document.folderPath || '',
    deletedBy: req.user._id.toString(),
    deletedAt: new Date().toISOString(),
  });

  res.status(200).json({
    status: 'success',
    message: 'Document deleted successfully',
  });
});

/**
 * Permanently delete document
 */
exports.permanentDeleteDocument = catchAsync(async (req, res, next) => {
  const document = await Document.findOne({
    _id: req.params.id,
    tenantId: req.user.tenantId,
  });

  if (!document) {
    return next(new AppError(`Document with ID "${req.params.id}" not found.`, 404));
  }

  // Only admin or document owner can permanently delete
  const canPermanentDelete = await canMutateWorkspaceDocument(req, document);
  if (!isEnterpriseAdmin(req.user) && !canPermanentDelete && document.uploadedBy.toString() !== req.user._id.toString()) {
    return next(new AppError('You do not have permission to permanently delete this document', 403));
  }

  // Delete from Wasabi
  try {
    await deleteFile(document.fileKey);
  } catch (wasabiError) {
    if (wasabiError.code === 'NoSuchKey') {
      console.warn(`Document file already deleted from storage: ${document.fileKey}`);
      // Continue - file may have been deleted externally
    } else if (wasabiError.code === 'Forbidden' || wasabiError.code === 'AccessDenied') {
      return next(new AppError('Storage permission denied when deleting file. Verify Wasabi credentials.', 503));
    } else if (wasabiError.code === 'NoSuchBucket') {
      return next(new AppError('Storage bucket not found. Verify bucket configuration.', 503));
    } else {
      // Re-throw for generic error handler
      throw wasabiError;
    }
  }

  // Delete all versions
  for (const version of document.versions) {
    if (version.fileKey !== document.fileKey) {
      try {
        await deleteFile(version.fileKey);
      } catch (wasabiError) {
        if (wasabiError.code !== 'NoSuchKey') {
          console.warn(`Failed to delete version file: ${version.fileKey}`, wasabiError.message);
        }
        // Continue even if version deletion fails
      }
    }
  }

  // Delete from database
  document.$locals.currentUser = req.user;
  await document.deleteOne();

  await User.findByIdAndUpdate(document.owner, {
    $inc: { storageUsed: -Math.max(Number(document.fileSize || 0), 0) },
  });

  await User.updateOne(
    { _id: document.owner, storageUsed: { $lt: 0 } },
    { $set: { storageUsed: 0 } }
  );

  // Log activity
  await log(req, 'document_permanent_delete', 'document', document._id, { documentName: document.name });

  res.status(200).json({
    status: 'success',
    message: 'Document permanently deleted',
  });
});

/**
 * Download document
 */
exports.downloadDocument = catchAsync(async (req, res, next) => {
  const disposition = req.query.disposition === 'inline' ? 'inline' : 'attachment';
  const shouldProxy = req.query.proxy === 'true';

  const document = await Document.findOne({
    _id: req.params.id,
    tenantId: req.user.tenantId,
    isDeleted: false,
  });

  if (!document) {
    return next(new AppError(`Document with ID "${req.params.id}" not found. It may have been deleted.`, 404));
  }

  // Check permissions
  const canDownload = document.canUserAccess(req.user._id, 'view') || await canViewWorkspaceDocument(req, document);
  if (!canDownload) {
    return next(new AppError('You do not have permission to download this document', 403));
  }

  if (shouldProxy) {
    let fileObject;
    try {
      fileObject = await downloadFile(document.fileKey);
    } catch (wasabiError) {
      if (wasabiError.code === 'NoSuchKey') {
        return next(new AppError('Document file not found in storage. File may have been deleted externally.', 404));
      }
      if (wasabiError.code === 'Forbidden' || wasabiError.code === 'AccessDenied') {
        return next(new AppError('Storage service permission denied when accessing file. Verify Wasabi credentials.', 503));
      }
      if (wasabiError.code === 'NoSuchBucket') {
        return next(new AppError('Storage bucket not found. Verify bucket configuration.', 503));
      }
      throw wasabiError;
    }

    const fileBuffer = Buffer.isBuffer(fileObject?.Body)
      ? fileObject.Body
      : Buffer.from(fileObject?.Body || '');

    if (fileBuffer.length === 0) {
      return next(new AppError('Stored document is empty or corrupted. Please re-upload the file.', 422));
    }

    if (document.mimeType === 'application/pdf' && disposition === 'inline') {
      if (!isLikelyPdfBuffer(fileBuffer)) {
        return next(new AppError('Stored PDF cannot be previewed because it appears corrupted. Please re-upload the file or download it directly.', 422));
      }
    }

    const safeFileName = String(document.filename || document.originalName || document.name || 'document')
      .replace(/[\r\n]/g, ' ')
      .replace(/["\\]/g, '')
      .trim() || 'document';

    res.setHeader('Content-Type', document.mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', fileBuffer.length);
    res.setHeader('Content-Disposition', `${disposition}; filename="${safeFileName}"`);

    // Log access for proxied download/view as well.
    await document.logAccess(req.user._id, 'download');
    await log(req, 'document_download', 'document', document._id, { documentName: document.name });

    return res.status(200).send(fileBuffer);
  }

  // Get signed URL
  let signedUrl;
  try {
    signedUrl = await getSignedUrl(document.fileKey, {
      downloadName: document.filename || document.name || 'document',
      disposition,
    });
  } catch (wasabiError) {
    if (wasabiError.code === 'NoSuchKey') {
      return next(new AppError('Document file not found in storage. File may have been deleted externally.', 404));
    }
    if (wasabiError.code === 'Forbidden' || wasabiError.code === 'AccessDenied') {
      return next(new AppError('Storage service permission denied when accessing file. Verify Wasabi credentials.', 503));
    }
    if (wasabiError.code === 'NoSuchBucket') {
      return next(new AppError('Storage bucket not found. Verify bucket configuration.', 503));
    }
    // Re-throw for generic error handler
    throw wasabiError;
  }

  // Log access
  await document.logAccess(req.user._id, 'download');

  // Log activity
  await log(req, 'document_download', 'document', document._id, { documentName: document.name });

  res.status(200).json({
    status: 'success',
    data: {
      url: signedUrl,
    },
  });
});

/**
 * Share document
 */
exports.shareDocument = catchAsync(async (req, res, next) => {
  const { userId, userEmail, permission, message } = req.body;

  const document = await Document.findOne({
    _id: req.params.id,
    tenantId: req.user.tenantId,
    isDeleted: false,
  });

  if (!document) {
    return next(new AppError(`Document with ID "${req.params.id}" not found. It may have been deleted.`, 404));
  }

  // Check permissions
  const canShare = document.canUserAccess(req.user._id, 'share') || await canMutateWorkspaceDocument(req, document);
  if (!canShare) {
    return next(new AppError('You do not have permission to share this document', 403));
  }

  // Resolve target user by id or email in the same tenant
  const userQuery = { tenantId: req.user.tenantId };
  if (userId) {
    userQuery._id = userId;
  } else if (userEmail) {
    userQuery.email = userEmail.toLowerCase();
  } else {
    return next(new AppError('Please provide userId or userEmail', 400));
  }

  const userToShare = await User.findOne(userQuery);

  if (!userToShare) {
    return next(new AppError(`User with email "${userEmail || userId}" not found in your organization.`, 404));
  }

  // Check if already shared
  const targetUserId = userToShare._id.toString();
  const existingShare = document.sharedWith.find(
    share => share.user.toString() === targetUserId
  );

  if (existingShare) {
    // Update permission
    existingShare.permission = permission;
  } else {
    // Add new share
    document.sharedWith.push({
      user: targetUserId,
      permission,
      sharedBy: req.user._id,
    });
  }

  document.$locals.currentUser = req.user;
  await document.save();

  // Send email notification, but do not fail sharing if email service is unavailable.
  try {
    await sendDocumentSharedEmail(userToShare, document, req.user);
  } catch (emailError) {
    console.error('Document shared but email notification failed:', emailError.message);
  }

  // Log activity
  await log(req, 'document_share', 'document', document._id, {
    documentName: document.name,
    sharedWith: userToShare.email,
    permission,
  });

  res.status(200).json({
    status: 'success',
    message: 'Document shared successfully',
    data: {
      document,
    },
  });
});

/**
 * Unshare document
 */
exports.unshareDocument = catchAsync(async (req, res, next) => {
  const { userId } = req.params;

  const document = await Document.findOne({
    _id: req.params.id,
    tenantId: req.user.tenantId,
    isDeleted: false,
  });

  if (!document) {
    return next(new AppError(`Document with ID "${req.params.id}" not found. It may have been deleted.`, 404));
  }

  // Check permissions
  if (!document.canUserAccess(req.user._id, 'share')) {
    return next(new AppError('You do not have permission to unshare this document', 403));
  }

  // Remove share
  document.sharedWith = document.sharedWith.filter(
    share => share.user.toString() !== userId
  );

  document.$locals.currentUser = req.user;
  await document.save();

  // Log activity
  await log(req, 'document_unshare', 'document', document._id, { documentName: document.name });

  res.status(200).json({
    status: 'success',
    message: 'Document unshared successfully',
  });
});

/**
 * Get document versions
 */
exports.getVersions = catchAsync(async (req, res, next) => {
  const document = await Document.findOne({
    _id: req.params.id,
    tenantId: req.user.tenantId,
    isDeleted: false,
  }).populate('versions.uploadedBy', 'firstName lastName email');

  if (!document) {
    return next(new AppError(`Document with ID "${req.params.id}" not found. It may have been deleted.`, 404));
  }

  // Check permissions
  const canViewVersions = document.canUserAccess(req.user._id, 'view') || await canViewWorkspaceDocument(req, document);
  if (!canViewVersions) {
    return next(new AppError('You do not have permission to view this document', 403));
  }

  res.status(200).json({
    status: 'success',
    results: document.versions.length,
    data: {
      versions: document.versions,
    },
  });
});

/**
 * Restore document version
 */
exports.restoreVersion = catchAsync(async (req, res, next) => {
  const { versionNumber } = req.params;

  const document = await Document.findOne({
    _id: req.params.id,
    tenantId: req.user.tenantId,
    isDeleted: false,
  });

  if (!document) {
    return next(new AppError(`Document with ID "${req.params.id}" not found. It may have been deleted.`, 404));
  }

  // Check permissions
  const canRestore = document.canUserAccess(req.user._id, 'edit') || await canMutateWorkspaceDocument(req, document);
  if (!canRestore) {
    return next(new AppError('You do not have permission to restore this document', 403));
  }

  // Find version
  const version = document.versions.find(v => v.version === parseInt(versionNumber));
  if (!version) {
    return next(new AppError(`Version ${versionNumber} not found. Available versions: ${document.versions.map(v => v.version).join(', ')}`, 404));
  }

  // Create new version from restored version
  const newVersion = {
    version: document.versions.length + 1,
    fileKey: version.fileKey,
    size: version.size,
    uploadedBy: req.user._id,
    uploadedAt: Date.now(),
    changes: `Restored version ${versionNumber}`,
  };

  document.versions.push(newVersion);
  document.fileKey = version.fileKey;
  document.size = version.size;

  document.$locals.currentUser = req.user;

  await document.save();

  // Log activity
  await log(req, 'document_restore_version', 'document', document._id, {
    documentName: document.name,
    versionNumber,
  });

  res.status(200).json({
    status: 'success',
    message: 'Version restored successfully',
    data: {
      document,
    },
  });
});

/**
 * Get document statistics
 */
exports.getStatistics = catchAsync(async (req, res, next) => {
  const stats = await Document.aggregate([
    {
      $match: {
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
        avgSize: { $avg: '$size' },
      },
    },
  ]);

  const categoryStats = await Document.aggregate([
    {
      $match: {
        tenantId: req.user.tenantId,
        isDeleted: false,
      },
    },
    {
      $group: {
        _id: '$category',
        count: { $sum: 1 },
        totalSize: { $sum: '$size' },
      },
    },
  ]);

  res.status(200).json({
    status: 'success',
    data: {
      overview: stats[0] || {
        totalDocuments: 0,
        totalSize: 0,
        avgSize: 0,
      },
      byCategory: categoryStats,
    },
  });
});

/**
 * Get dashboard stats for user
 */
exports.getDashboardStats = catchAsync(async (req, res, next) => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfWeek = new Date(now.setDate(now.getDate() - 7));
  const accessibleWorkspaceIds = await getAccessibleWorkspaceIds(req);

  // Build query for user's accessible documents
  const baseQuery = {
    tenantId: req.user.tenantId,
    isDeleted: false,
  };

  if (!isEnterpriseAdmin(req.user)) {
    const workspaceScope = accessibleWorkspaceIds && accessibleWorkspaceIds.length > 0
      ? [{ workspaceId: { $in: accessibleWorkspaceIds } }]
      : [];

    baseQuery.$or = [
      { uploadedBy: req.user._id },
      { owner: req.user._id },
      { 'sharedWith.user': req.user._id },
      { visibility: 'public' },
      ...workspaceScope,
    ];
  }

  // Total documents
  const totalDocuments = await Document.countDocuments(baseQuery);

  // Documents uploaded this month
  const thisMonth = await Document.countDocuments({
    ...baseQuery,
    createdAt: { $gte: startOfMonth },
  });

  // Recent documents (last 7 days)
  const recent = await Document.countDocuments({
    ...baseQuery,
    createdAt: { $gte: startOfWeek },
  });

  // Get recent documents for display
  const recentDocuments = await Document.find(baseQuery)
    .populate('uploadedBy', 'firstName lastName email')
    .sort('-createdAt')
    .limit(6);

  const [tenantStorage, tenantUsers, tenantDocumentUsage] = await Promise.all([
    getTenantStorageSummary(req.user.tenantId),
    User.find({ tenantId: req.user.tenantId, isActive: true })
      .select('firstName lastName email role storageUsed')
      .sort({ storageUsed: -1, firstName: 1 })
      .limit(50),
    Document.aggregate([
      {
        $match: {
          tenantId: req.user.tenantId,
          isDeleted: false,
        },
      },
      {
        $group: {
          _id: {
            $ifNull: ['$uploadedBy', '$owner'],
          },
          storageUsed: {
            $sum: {
              $ifNull: ['$size', '$fileSize'],
            },
          },
        },
      },
    ]),
  ]);

  const usageByUserId = new Map(
    (tenantDocumentUsage || []).map((entry) => [
      String(entry._id || ''),
      Number(entry.storageUsed || 0),
    ]),
  );

  const tenantUsed = (tenantDocumentUsage || []).reduce(
    (total, entry) => total + Number(entry.storageUsed || 0),
    0,
  );

  const planLimitFallback = gbToBytes(Number(tenantStorage.storagePlanGb || 50));
  const tenantLimit = Number(tenantStorage.storageLimit || 0) > 0
    ? Number(tenantStorage.storageLimit)
    : planLimitFallback;

  const spaceUsers = tenantUsers.map((spaceUser) => {
    const storageUsed = usageByUserId.get(String(spaceUser._id)) || 0;
    return {
      _id: spaceUser._id,
      firstName: spaceUser.firstName,
      lastName: spaceUser.lastName,
      email: spaceUser.email,
      role: spaceUser.role,
      storageUsed,
      usagePercentOfTenant: tenantLimit > 0
        ? Number(((storageUsed / tenantLimit) * 100).toFixed(2))
        : 0,
    };
  });

  res.status(200).json({
    status: 'success',
    data: {
      totalDocuments,
      thisMonth,
      recent,
      recentDocuments,
      spaceUsage: {
        storageUsed: tenantUsed,
        storageLimit: tenantLimit,
        storageRemaining: Math.max(tenantLimit - tenantUsed, 0),
        storageUsedPercentage: tenantLimit > 0
          ? Number(((tenantUsed / tenantLimit) * 100).toFixed(2))
          : 0,
      },
      spaceUsers,
    },
  });
});
