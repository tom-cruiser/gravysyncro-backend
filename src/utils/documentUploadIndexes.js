const DocumentUpload = require('../models/DocumentUpload');

const repairDocumentUploadIndexes = async () => {
  const collection = DocumentUpload.collection;

  try {
    const indexes = await collection.indexes();
    const legacyIndex = indexes.find((index) => index.name === 'uploadId_1');

    if (legacyIndex) {
      await collection.dropIndex('uploadId_1');
    }
  } catch (error) {
    if (error?.codeName !== 'IndexNotFound' && error?.code !== 27) {
      throw error;
    }
  }

  await DocumentUpload.syncIndexes();
};

module.exports = { repairDocumentUploadIndexes };