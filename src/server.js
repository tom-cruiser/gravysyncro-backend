const dotenv = require('dotenv');
const http = require('http');
const { Server } = require('socket.io');

// Load environment variables before importing other modules that read process.env.
dotenv.config({ path: require('path').resolve(__dirname, '../.env') });

const app = require('./app');
const connectDB = require('./config/database');
const { startStorageQuotaNotifier } = require('./jobs/storageQuotaNotifier');
const { startStaleUploadCleaner } = require('./jobs/staleUploadCleaner');
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

// Connect to database
connectDB();

const server = http.createServer(app);
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

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running in ${process.env.NODE_ENV} mode on port ${PORT}`);
  startStorageQuotaNotifier();
  startStaleUploadCleaner();
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
