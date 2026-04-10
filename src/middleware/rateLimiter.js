const rateLimit = require('express-rate-limit');
const AppError = require('../utils/appError');

const isLimiterDisabled = (envFlagName) => {
  const scopedFlag = process.env[envFlagName];
  if (typeof scopedFlag === 'string') {
    return scopedFlag.toLowerCase() === 'false';
  }

  const globalFlag = process.env.ENABLE_RATE_LIMITING;
  return typeof globalFlag === 'string' && globalFlag.toLowerCase() === 'false';
};

// General API rate limiter
exports.apiLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => ['GET', 'HEAD', 'OPTIONS'].includes(req.method),
  handler: (req, res, next) => {
    next(new AppError('Too many requests from this IP, please try again later.', 429));
  },
});

// Strict rate limiter for authentication endpoints
exports.authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 requests per window
  skipSuccessfulRequests: true,
  skip: () => isLimiterDisabled('ENABLE_AUTH_RATE_LIMITING'),
  message: 'Too many authentication attempts, please try again later.',
  handler: (req, res, next) => {
    next(new AppError('Too many authentication attempts, please try again after 15 minutes.', 429));
  },
});

// Upload rate limiter
exports.uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: parseInt(process.env.UPLOAD_LIMIT_MAX_REQUESTS) || 300,
  skip: () => isLimiterDisabled('ENABLE_UPLOAD_RATE_LIMITING'),
  message: 'Too many file uploads, please try again later.',
  handler: (req, res, next) => {
    next(new AppError('Upload limit exceeded. Please try again later.', 429));
  },
});

// Password reset limiter
exports.passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // 3 requests per hour
  message: 'Too many password reset attempts, please try again later.',
  handler: (req, res, next) => {
    next(new AppError('Too many password reset attempts. Please try again later.', 429));
  },
});
