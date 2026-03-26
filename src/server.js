const dotenv = require('dotenv');

// Load environment variables before importing other modules that read process.env.
dotenv.config({ path: require('path').resolve(__dirname, '../.env') });

const app = require('./app');
const connectDB = require('./config/database');
const { startStorageQuotaNotifier } = require('./jobs/storageQuotaNotifier');
const { startStaleUploadCleaner } = require('./jobs/staleUploadCleaner');

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION! 💥 Shutting down...');
  console.error(err.name, err.message);
  console.error(err.stack);
  process.exit(1);
});

// Connect to database
connectDB();

// Start server
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
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
