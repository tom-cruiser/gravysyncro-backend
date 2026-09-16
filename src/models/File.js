const mongoose = require('mongoose');

// Backs the Plus file vault (routes/files.routes.js): unrestricted,
// any-file-type storage that returns bytes unchanged on download. Kept
// separate from models/Document.js on purpose — that model's upload
// pipeline enforces a MIME whitelist and re-encodes images through sharp,
// neither of which is compatible with a byte-for-byte guarantee.
const fileSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  storedPath: {
    type: String,
    required: true,
  },
  originalName: {
    type: String,
    required: true,
  },
  mimeType: {
    type: String,
    default: 'application/octet-stream',
  },
  size: {
    type: Number,
    required: true,
  },
  uploadedAt: {
    type: Date,
    default: Date.now,
  },
});

fileSchema.index({ userId: 1, uploadedAt: -1 });

module.exports = mongoose.model('File', fileSchema);
