let ioInstance = null;

const setSocketServer = (io) => {
  ioInstance = io;
};

const getSocketServer = () => ioInstance;

const emitNotification = (tenantId, userId, notification) => {
  if (!ioInstance || !tenantId || !userId) {
    return;
  }

  ioInstance.to(`tenant:${tenantId}`).to(`user:${userId}`).emit('notification:new', notification);
};

const emitTenantEvent = (tenantId, eventName, payload = {}) => {
  if (!ioInstance || !tenantId || !eventName) {
    return;
  }

  ioInstance.to(`tenant:${tenantId}`).emit(eventName, payload);
};

// Targets exactly one user's own room — unlike emitNotification, which
// (via its chained .to().to()) also reaches everyone else in that user's
// tenant. Used where a broadcast should stay scoped to a single
// recipient, e.g. pushing a live message-list update to admins.
const emitToUser = (userId, eventName, payload = {}) => {
  if (!ioInstance || !userId || !eventName) {
    return;
  }

  ioInstance.to(`user:${userId}`).emit(eventName, payload);
};

module.exports = {
  setSocketServer,
  getSocketServer,
  emitNotification,
  emitTenantEvent,
  emitToUser,
};