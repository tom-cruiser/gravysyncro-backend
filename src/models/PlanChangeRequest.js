const mongoose = require('mongoose');

// A self-service storage-plan switch (Billing.jsx) no longer applies
// immediately — it opens one of these, an admin reviews it from the
// Plan Requests tab, and only approval actually calls
// applyTenantStoragePlan / createInvoiceForTenant. See
// userController.updateSubscriptionPlan and
// adminController.approvePlanRequest / rejectPlanRequest.
const planChangeRequestSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true,
  },
  requestedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },

  currentPlanGb: { type: Number, required: true },
  requestedPlanGb: { type: Number, required: true },
  requestedPlanId: { type: String, required: true },
  requestedPlanName: { type: String, required: true },

  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
    index: true,
  },

  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  reviewedAt: Date,
  reviewNote: String,
}, {
  timestamps: true,
});

planChangeRequestSchema.index({ tenantId: 1, status: 1 });

module.exports = mongoose.model('PlanChangeRequest', planChangeRequestSchema);
