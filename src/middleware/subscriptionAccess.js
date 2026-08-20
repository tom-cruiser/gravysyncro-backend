const AppError = require('../utils/appError');
const { isEnterpriseAdmin } = require('../utils/workspaceAccess');

/**
 * Blocks access to core paid features (document archiving, audio/video
 * storage, real-time collaboration) once a user's trial has expired and no
 * active or admin-approved subscription has replaced it.
 *
 * Must be mounted after `protect` — it reads `req.user`, which `protect`
 * attaches after verifying the JWT.
 *
 * IMPORTANT: this checks `isSubscriptionActive === false` explicitly, never
 * a falsy/undefined check (`!req.user.isSubscriptionActive`). Users created
 * before this field existed have it as `undefined`, and `undefined` must
 * mean "not locked" — otherwise shipping this feature would instantly lock
 * out every account that already existed.
 */
exports.requireActiveSubscription = (req, res, next) => {
  if (!req.user) {
    return next(new AppError('You are not logged in. Please log in to access this resource.', 401));
  }

  // Platform admins (role 'Admin' normalizes to 'Enterprise Admin' — see
  // utils/workspaceAccess.js) can always act, even past their own trial
  // window, so they're never locked out of fixing a tenant's access.
  if (isEnterpriseAdmin(req.user)) {
    return next();
  }

  if (req.user.isSubscriptionActive === false) {
    return next(
      new AppError(
        'Your trial has expired. Subscribe to a plan or contact an admin to restore access.',
        402,
      ),
    );
  }

  return next();
};
