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

module.exports = {
  setSocketServer,
  getSocketServer,
  emitNotification,
  emitTenantEvent,
};