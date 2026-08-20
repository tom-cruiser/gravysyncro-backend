const Message = require('../models/Message');
const User = require('../models/User');
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const { isEnterpriseAdmin } = require('../utils/workspaceAccess');
const { sendSlackMessage } = require('../services/slackService');
const { createNotification } = require('./notificationController');
const { emitToUser } = require('../config/socket');

/**
 * Create a new support message (User)
 */
exports.createMessage = catchAsync(async (req, res, next) => {
  const { subject, message, category, priority } = req.body;

  const newMessage = await Message.create({
    tenantId: req.tenantId,
    user: req.user._id,
    subject,
    message,
    category: category || 'general',
    priority: priority || 'medium',
  });

  await newMessage.populate('user', 'firstName lastName email');

  // Notify every admin — createNotification both saves the Notification
  // row and pushes it live over socket.io (notification:new) to anyone
  // with that tab open, so the bell updates without a page reload.
  const admins = await User.find({ role: 'Admin' });
  await Promise.all(admins.map((admin) => createNotification({
    tenantId: admin.tenantId,
    user: admin._id,
    type: 'message_received',
    title: 'New Support Message',
    message: `${req.user.firstName} ${req.user.lastName} sent a new support message: "${subject}"`,
    relatedMessage: newMessage._id,
    relatedUser: req.user._id,
  })));

  // Separate from the notification bell — this is what lets an admin's
  // open Messages/Contact Messages tab insert the new row live instead
  // of waiting for a manual refresh.
  admins.forEach((admin) => emitToUser(admin._id, 'message:new', {
    message: newMessage,
    source: newMessage.source || 'app',
  }));

  // Fire-and-forget: never let a Slack hiccup slow down or fail this request.
  // sendSlackMessage already swallows its own errors and logs them.
  sendSlackMessage(
    [
      ':envelope: *New support message*',
      `*From:* ${req.user.firstName} ${req.user.lastName} (${req.user.email})`,
      `*Subject:* ${subject}`,
      `*Priority:* ${newMessage.priority} · *Category:* ${newMessage.category}`,
      `*Message:* ${message}`,
    ].join('\n')
  );

  res.status(201).json({
    status: 'success',
    data: { message: newMessage }
  });
});

/**
 * Create a message from the public landing-page contact form. No auth,
 * no tenant — this is an anonymous visitor, so we snapshot their contact
 * details onto the message itself rather than referencing a User.
 */
exports.createPublicMessage = catchAsync(async (req, res) => {
  const { email, countryCode, phoneNumber, subject, message } = req.body;
  const phone = [countryCode, phoneNumber].filter(Boolean).join(' ').trim();

  const newMessage = await Message.create({
    tenantId: 'public',
    source: 'public_contact_form',
    visitor: { email, phone },
    subject,
    message,
    category: 'general',
    priority: 'medium',
  });

  // Notify all admins in-app, same as the authenticated flow — but with
  // its own notification type so the frontend can route a click straight
  // to the "Contact Messages" admin tab instead of "Messages". Using
  // createNotification (not a raw insertMany) means each one is also
  // pushed live over socket.io so the bell updates immediately.
  const admins = await User.find({ role: 'Admin' });
  await Promise.all(admins.map((admin) => createNotification({
    tenantId: admin.tenantId,
    user: admin._id,
    type: 'contact_form_received',
    title: 'New Contact Form Submission',
    message: `${email} sent a message via the contact form: "${subject}"`,
    relatedMessage: newMessage._id,
  })));

  // Separate from the notification bell — this is what lets an admin's
  // open Contact Messages tab insert the new row live.
  admins.forEach((admin) => emitToUser(admin._id, 'message:new', {
    message: newMessage,
    source: newMessage.source,
  }));

  // Fire-and-forget: never let a Slack hiccup slow down or fail this request.
  // sendSlackMessage already swallows its own errors and logs them.
  sendSlackMessage(
    [
      ':envelope_with_arrow: *New contact form submission*',
      `*From:* ${email}${phone ? ` · ${phone}` : ''}`,
      `*Subject:* ${subject}`,
      `*Message:* ${message}`,
    ].join('\n')
  );

  res.status(201).json({
    status: 'success',
    message: 'Thanks for reaching out — we will get back to you soon.',
  });
});

/**
 * Get user's own messages
 */
exports.getMyMessages = catchAsync(async (req, res, next) => {
  const { status, page = 1, limit = 20 } = req.query;

  const query = {
    tenantId: req.tenantId,
    user: req.user._id,
  };

  if (status) query.status = status;

  const skip = (page - 1) * limit;

  const [messages, total] = await Promise.all([
    Message.find(query)
      .populate('user', 'firstName lastName email')
      .populate('respondedBy', 'firstName lastName email')
      .sort('-createdAt')
      .skip(skip)
      .limit(parseInt(limit)),
    Message.countDocuments(query)
  ]);

  res.status(200).json({
    status: 'success',
    results: messages.length,
    data: {
      messages,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    }
  });
});

/**
 * Get all messages (Admin only)
 */
exports.getAllMessages = catchAsync(async (req, res, next) => {
  const {
    status,
    priority,
    category,
    isRead,
    search,
    source,
    page = 1,
    limit = 20,
    sortBy = '-createdAt'
  } = req.query;

  const query = {};

  if (status) query.status = status;
  if (priority) query.priority = priority;
  if (category) query.category = category;
  if (isRead !== undefined) query.isRead = isRead === 'true';

  // Messages created before the `source` field existed have no such field
  // stored at all (not even "app") — so "app" must match "anything that
  // isn't a public contact-form message" rather than an exact equality,
  // or every pre-existing support message would vanish from that tab.
  if (source === 'public_contact_form') {
    query.source = 'public_contact_form';
  } else if (source === 'app') {
    query.source = { $ne: 'public_contact_form' };
  }

  if (search) {
    query.$or = [
      { subject: { $regex: search, $options: 'i' } },
      { message: { $regex: search, $options: 'i' } }
    ];
  }

  const skip = (page - 1) * limit;

  // Scoped to the same filters as the list itself (minus isRead, since we
  // want the unread count regardless of the isRead filter currently
  // applied) — otherwise this badge would show the same global number on
  // both the Support and Contact Messages tabs.
  const { isRead: _omitIsRead, ...unreadQueryBase } = query;
  const unreadQuery = { ...unreadQueryBase, isRead: false };

  const [messages, total, unreadCount] = await Promise.all([
    Message.find(query)
      .populate('user', 'firstName lastName email tenantId')
      .populate('respondedBy', 'firstName lastName email')
      .sort(sortBy)
      .skip(skip)
      .limit(parseInt(limit)),
    Message.countDocuments(query),
    Message.countDocuments(unreadQuery)
  ]);

  res.status(200).json({
    status: 'success',
    results: messages.length,
    data: {
      messages,
      unreadCount,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    }
  });
});

/**
 * Get message by ID
 */
exports.getMessageById = catchAsync(async (req, res, next) => {
  const message = await Message.findById(req.params.messageId)
    .populate('user', 'firstName lastName email tenantId')
    .populate('respondedBy', 'firstName lastName email');

  if (!message) {
    return next(new AppError('Message not found', 404));
  }

  // Check if user is admin or message owner. Public contact-form
  // messages have no `user` at all, so only an admin may view those.
  const isOwner = message.user && message.user._id.toString() === req.user._id.toString();
  if (!isEnterpriseAdmin(req.user) && !isOwner) {
    return next(new AppError('You do not have permission to view this message', 403));
  }

  res.status(200).json({
    status: 'success',
    data: { message }
  });
});

/**
 * Update message (Admin only)
 */
exports.updateMessage = catchAsync(async (req, res, next) => {
  const { status, priority, category, isRead } = req.body;

  const message = await Message.findById(req.params.messageId);

  if (!message) {
    return next(new AppError('Message not found', 404));
  }

  if (status) message.status = status;
  if (priority) message.priority = priority;
  if (category) message.category = category;
  if (isRead !== undefined) message.isRead = isRead;

  await message.save();

  await message.populate('user', 'firstName lastName email');
  await message.populate('respondedBy', 'firstName lastName email');

  res.status(200).json({
    status: 'success',
    data: { message }
  });
});

/**
 * Respond to message (Admin only)
 */
exports.respondToMessage = catchAsync(async (req, res, next) => {
  const { response, status } = req.body;

  if (!response) {
    return next(new AppError('Response text is required', 400));
  }

  const message = await Message.findById(req.params.messageId).populate('user', 'firstName lastName email tenantId');

  if (!message) {
    return next(new AppError('Message not found', 404));
  }

  message.response = response;
  message.respondedBy = req.user._id;
  message.respondedAt = new Date();
  message.status = status || 'resolved';
  message.isRead = true;

  await message.save();

  // Create an in-app notification for the user who sent the message —
  // createNotification also pushes it live over socket.io, so it shows
  // up in their bell immediately rather than on their next page load.
  // Public contact-form messages have no `user` account to notify this
  // way — the response is still saved on the message itself above and
  // visible to admins, it just isn't pushed to anyone in-app.
  if (message.user) {
    await createNotification({
      tenantId: message.user.tenantId,
      user: message.user._id,
      type: 'support_response',
      title: 'Support Response Received',
      message: `Your support request "${message.subject}" has been responded to by our team.`,
      relatedMessage: message._id,
      relatedUser: req.user._id,
    });
  }

  await message.populate('respondedBy', 'firstName lastName email');

  res.status(200).json({
    status: 'success',
    data: { message }
  });
});

/**
 * Delete message (Admin only)
 */
exports.deleteMessage = catchAsync(async (req, res, next) => {
  const message = await Message.findByIdAndDelete(req.params.messageId);

  if (!message) {
    return next(new AppError('Message not found', 404));
  }

  res.status(204).json({
    status: 'success',
    data: null
  });
});

/**
 * Mark message as read (Admin only)
 */
exports.markAsRead = catchAsync(async (req, res, next) => {
  const message = await Message.findByIdAndUpdate(
    req.params.messageId,
    { isRead: true },
    { new: true }
  ).populate('user', 'firstName lastName email');

  if (!message) {
    return next(new AppError('Message not found', 404));
  }

  res.status(200).json({
    status: 'success',
    data: { message }
  });
});

/**
 * Get message statistics (Admin only)
 */
exports.getMessageStats = catchAsync(async (req, res, next) => {
  const [stats] = await Message.aggregate([
    {
      $facet: {
        statusCounts: [
          { $group: { _id: '$status', count: { $sum: 1 } } }
        ],
        priorityCounts: [
          { $group: { _id: '$priority', count: { $sum: 1 } } }
        ],
        categoryCounts: [
          { $group: { _id: '$category', count: { $sum: 1 } } }
        ],
        totalStats: [
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              unread: {
                $sum: { $cond: [{ $eq: ['$isRead', false] }, 1, 0] }
              },
              pending: {
                $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] }
              }
            }
          }
        ]
      }
    }
  ]);

  res.status(200).json({
    status: 'success',
    data: { stats }
  });
});
