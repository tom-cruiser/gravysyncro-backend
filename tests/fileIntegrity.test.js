const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const mongoose = require('mongoose');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const app = require('../src/app');
const User = require('../src/models/User');
const File = require('../src/models/File');

// Buffers a binary response body instead of letting superagent try to
// parse/decode it as text — required to assert byte-for-byte equality.
const parseAsBuffer = (res, callback) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};

describe('Plus file vault: upload/download integrity', () => {
  let user;
  let token;
  const tenantId = `test-tenant-${Date.now()}`;

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGODB_TEST_URI || process.env.MONGODB_URI);

    user = await User.create({
      tenantId,
      firstName: 'Integrity',
      lastName: 'Tester',
      email: `plus-integrity-${Date.now()}@example.com`,
      password: 'Password123',
      isPlus: true,
    });

    token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '1h',
    });
  });

  afterAll(async () => {
    const files = await File.find({ userId: user._id });
    await Promise.all(files.map((file) => fs.promises.unlink(file.storedPath).catch(() => {})));
    await File.deleteMany({ userId: user._id });
    await User.deleteOne({ _id: user._id });
    await mongoose.disconnect();
  });

  it('returns a downloaded binary file with the exact bytes that were uploaded', async () => {
    // Random binary payload (not valid text in any encoding) so any
    // accidental text/encoding step along the way would corrupt it.
    const originalBuffer = crypto.randomBytes(2 * 1024 * 1024);
    const originalHash = crypto.createHash('sha256').update(originalBuffer).digest('hex');

    const uploadRes = await request(app)
      .post('/api/v1/files/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('files', originalBuffer, { filename: 'integrity-check.bin', contentType: 'application/octet-stream' });

    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body.data.files).toHaveLength(1);
    const fileId = uploadRes.body.data.files[0].id;
    expect(uploadRes.body.data.files[0].originalName).toBe('integrity-check.bin');
    expect(uploadRes.body.data.files[0].size).toBe(originalBuffer.length);

    const downloadRes = await request(app)
      .get(`/api/v1/files/${fileId}/download`)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .parse(parseAsBuffer);

    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers['content-type']).toBe('application/octet-stream');
    expect(downloadRes.headers['content-disposition']).toContain('integrity-check.bin');
    expect(Number(downloadRes.headers['content-length'])).toBe(originalBuffer.length);

    const downloadedHash = crypto.createHash('sha256').update(downloadRes.body).digest('hex');
    expect(downloadedHash).toBe(originalHash);
    expect(Buffer.compare(downloadRes.body, originalBuffer)).toBe(0);
  });
});
