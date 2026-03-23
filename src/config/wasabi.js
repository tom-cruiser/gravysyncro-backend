const AWS = require('aws-sdk');

const sanitizeFileName = (name = 'document') =>
  String(name)
    .replace(/[\r\n]/g, ' ')
    .replace(/["\\]/g, '')
    .trim() || 'document';

const encodeRFC5987ValueChars = (str) =>
  encodeURIComponent(str)
    .replace(/['()]/g, escape)
    .replace(/\*/g, '%2A');

const resolveWasabiEndpoint = () => {
  const configuredEndpoint = (process.env.WASABI_ENDPOINT || '').trim();
  const region = (process.env.WASABI_REGION || '').trim();

  if (!configuredEndpoint && region) {
    return `https://s3.${region}.wasabisys.com`;
  }

  if (configuredEndpoint === 'https://s3.wasabisys.com' && region) {
    return `https://s3.${region}.wasabisys.com`;
  }

  return configuredEndpoint;
};

// Configure Wasabi S3
const s3 = new AWS.S3({
  endpoint: resolveWasabiEndpoint(),
  region: process.env.WASABI_REGION,
  accessKeyId: process.env.WASABI_ACCESS_KEY_ID,
  secretAccessKey: process.env.WASABI_SECRET_ACCESS_KEY,
  signatureVersion: 'v4',
  s3ForcePathStyle: false,
});

/**
 * Upload file to Wasabi
 */
const uploadFile = async (key, body, contentType, metadata = {}) => {
  const params = {
    Bucket: process.env.WASABI_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
    Metadata: metadata,
    ServerSideEncryption: 'AES256',
  };

  return s3.upload(params).promise();
};

/**
 * Download file from Wasabi
 */
const downloadFile = async (key) => {
  const params = {
    Bucket: process.env.WASABI_BUCKET,
    Key: key,
  };

  return s3.getObject(params).promise();
};

/**
 * Delete file from Wasabi
 */
const deleteFile = async (key) => {
  const params = {
    Bucket: process.env.WASABI_BUCKET,
    Key: key,
  };

  return s3.deleteObject(params).promise();
};

/**
 * Generate signed URL for temporary access
 */
const getSignedUrl = (key, options = {}) => {
  const {
    expiresIn = 3600,
    downloadName,
    disposition = 'attachment',
  } = options;

  const params = {
    Bucket: process.env.WASABI_BUCKET,
    Key: key,
    Expires: expiresIn,
  };

  if (downloadName) {
    const safeName = sanitizeFileName(downloadName);
    const normalizedDisposition = disposition === 'inline' ? 'inline' : 'attachment';
    params.ResponseContentDisposition =
      `${normalizedDisposition}; filename=${safeName}; filename*=UTF-8''${encodeRFC5987ValueChars(safeName)}`;
  }

  return s3.getSignedUrl('getObject', params);
};

/**
 * Copy file within Wasabi
 */
const copyFile = async (sourceKey, destinationKey) => {
  const params = {
    Bucket: process.env.WASABI_BUCKET,
    CopySource: `${process.env.WASABI_BUCKET}/${sourceKey}`,
    Key: destinationKey,
    ServerSideEncryption: 'AES256',
  };

  return s3.copyObject(params).promise();
};

/**
 * List files in a folder
 */
const listFiles = async (prefix) => {
  const params = {
    Bucket: process.env.WASABI_BUCKET,
    Prefix: prefix,
  };

  return s3.listObjectsV2(params).promise();
};

module.exports = {
  s3,
  uploadFile,
  downloadFile,
  deleteFile,
  getSignedUrl,
  copyFile,
  listFiles,
};
