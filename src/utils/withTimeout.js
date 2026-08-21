/**
 * Races a promise against a timer so a hung outbound call (e.g. an
 * unreachable third-party API) fails fast with a clear error instead of
 * leaving the request pending forever — none of catchAsync, Express's
 * error handler, or a rejected promise can help with a promise that never
 * settles at all. Same pattern already used ad hoc in adminController.js's
 * health checks, pulled out here so other handlers can reuse it.
 */
const withTimeout = (promise, timeoutMs, timeoutMessage) => {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
    ),
  ]);
};

module.exports = withTimeout;
