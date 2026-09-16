const AppError = require('../utils/appError');

/**
 * Gates the Plus file vault (routes/files.routes.js) behind the user's
 * `isPlus` flag on the User model. Independent of `requireActiveSubscription`
 * (middleware/subscriptionAccess.js) — a user's trial/subscription can be
 * active without them being on Plus.
 *
 * Must be mounted after `protect`, which attaches `req.user`.
 */
exports.requirePlus = (req, res, next) => {
  if (!req.user) {
    return next(new AppError('You are not logged in. Please log in to access this resource.', 401));
  }

  if (!req.user.isPlus) {
    return next(new AppError('This feature requires a Plus plan. Upgrade to unlock the file vault.', 402));
  }

  return next();
};
