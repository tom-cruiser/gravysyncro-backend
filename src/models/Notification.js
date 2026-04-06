const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    // Multi-tenant identifier
    tenantId: {
      type: String,
      required: true,
      index: true,
    },

    // Recipient
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // Notification details
    type: {
      type: String,
      enum: [
        "document_shared",
        "comment_added",
        "document_uploaded",
        "workspace_uploaded",
        "workspace_comment",
        "workspace_archived",
        "workspace_reopened",
        "workspace_assigned",
        "mention",
        "system",
        "security",
        "support_response",
        "message_received",
      ],
      required: true,
    },
    title: {
      type: String,
      required: true,
    },
    message: {
      type: String,
      required: true,
    },

    // Related entities
    relatedDocument: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Document",
    },
    relatedWorkspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
    },
    relatedUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    relatedMessage: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
    },

    // Status
    read: {
      type: Boolean,
      default: false,
    },
    readAt: Date,

    // Link
    actionUrl: String,

    // Priority
    priority: {
      type: String,
      enum: ["low", "normal", "high"],
      default: "normal",
    },
  },
  {
    timestamps: true,
  },
);

// Indexes
notificationSchema.index({ tenantId: 1, user: 1, read: 1 });
notificationSchema.index({ tenantId: 1, user: 1, createdAt: -1 });

module.exports = mongoose.model("Notification", notificationSchema);
