const dotenv = require('dotenv');
const http = require('http');
const { Server } = require('socket.io');

// Load environment variables before importing other modules that read process.env.
dotenv.config({ path: require('path').resolve(__dirname, '../.env') });

const app = require('./app');
const connectDB = require('./config/database');
const { startStorageQuotaNotifier } = require('./jobs/storageQuotaNotifier');
const { startStaleUploadCleaner } = require('./jobs/staleUploadCleaner');
const { startInvoiceBiller } = require('./jobs/invoiceBiller');
const { startTrialAccessLock } = require('./jobs/trialAccessLock');
const { startEnterpriseSubscriptionExpiry } = require('./jobs/enterpriseSubscriptionExpiry');
const { repairDocumentUploadIndexes } = require('./utils/documentUploadIndexes');
const { setSocketServer } = require('./config/socket');
const jwt = require('jsonwebtoken');
const User = require('./models/User');

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION! 💥 Shutting down...');
  console.error(err.name, err.message);
  console.error(err.stack);
  process.exit(1);
});

const server = http.createServer(app);

// Increase timeouts for large file uploads (documents can now be up to
// 700MB). `server.timeout` is the idle-socket timeout; Node's http server
// also independently caps the total time to receive a full request via
// `requestTimeout` (default 5 minutes since Node 18) — a 700MB upload on a
// modest connection can easily take longer than that, so both need raising
// or large uploads get cut off partway through regardless of the socket
// staying active. `headersTimeout` only covers the request headers, not the
// body, so it's left short.
server.timeout = 60 * 60 * 1000; // 60 minutes
server.requestTimeout = 60 * 60 * 1000; // 60 minutes
server.headersTimeout = 2 * 60 * 1000; // 2 minutes
server.keepAliveTimeout = 65 * 1000;

const io = new Server(server, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    credentials: true,
  },
});

setSocketServer(io);

io.on('connection', (socket) => {
  socket.on('authenticate', async ({ token }) => {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id).select('tenantId');
      if (!user) return;

      socket.join(`tenant:${user.tenantId}`);
      socket.join(`user:${user._id}`);
      socket.data.userId = user._id.toString();
      socket.data.tenantId = user.tenantId;
      socket.emit('authenticated', { ok: true });
    } catch (error) {
      socket.emit('authenticated', { ok: false });
    }
  });
});

// Connect to database and repair the legacy DocumentUpload uploadId index.
const startServer = async () => {
  await connectDB();
  await repairDocumentUploadIndexes();

  const PORT = process.env.PORT || 5000;
  server.listen(PORT, () => {
    console.log(`🚀 Server running in ${process.env.NODE_ENV} mode on port ${PORT}`);
    startStorageQuotaNotifier();
    startStaleUploadCleaner();
    startInvoiceBiller();
    startTrialAccessLock();
    startEnterpriseSubscriptionExpiry();
  });
};

startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION! 💥 Shutting down...');
  console.error(err.name, err.message);
  server.close(() => {
    process.exit(1);
  });
});

// Handle SIGTERM
process.on('SIGTERM', () => {
  console.log('👋 SIGTERM RECEIVED. Shutting down gracefully');
  server.close(() => {
    console.log('💥 Process terminated!');
  });
});

// Handle SIGINT (Ctrl+C)
process.on('SIGINT', () => {
  console.log('👋 SIGINT RECEIVED. Shutting down gracefully');
  server.close(() => {
    console.log('💥 Process terminated!');
  });
});
