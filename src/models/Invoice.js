const mongoose = require('mongoose');

// A single line on the itemized breakdown (e.g. "Pro plan — 100 GB").
// All money fields are stored in cents (integers) to avoid floating-point
// rounding drift — the same convention Stripe and most billing systems use.
const lineItemSchema = new mongoose.Schema({
  description: { type: String, required: true },
  quantity: { type: Number, default: 1 },
  unitAmountCents: { type: Number, required: true },
  amountCents: { type: Number, required: true },
}, { _id: false });

const addressSchema = new mongoose.Schema({
  line1: String,
  line2: String,
  city: String,
  state: String,
  postalCode: String,
  country: String,
}, { _id: false });

const invoiceSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true,
  },
  // Unique per tenant, not globally — see generateInvoiceNumber in
  // utils/invoices.js. Every self-registered tenantId is `tenant_<uuid>`,
  // so a bare global-unique index here would make the SECOND tenant ever
  // billed collide with the first tenant's "INV-XXXX-000001" and fail
  // with a duplicate-key error (this actually happened: it's why the
  // monthly cron and the plan-change-request approval flow were both
  // silently failing with a 500).
  invoiceNumber: {
    type: String,
    required: true,
  },

  // There is no real payment gateway wired up yet (see utils/invoices.js),
  // so this is a self-contained billing ledger rather than a mirror of a
  // real charge. New invoices default to 'paid' to match the app's existing
  // self-service billing model (a plan switch takes effect immediately,
  // with no payment-collection gate) — but the field exists so a future
  // real integration can set 'pending' / 'failed' honestly.
  status: {
    type: String,
    enum: ['paid', 'pending', 'failed', 'void'],
    default: 'paid',
  },

  planId: { type: String, required: true },
  planName: { type: String, required: true },
  storageGb: { type: Number, required: true },

  periodStart: { type: Date, required: true },
  periodEnd: { type: Date, required: true },
  issuedAt: { type: Date, default: Date.now },

  lineItems: {
    type: [lineItemSchema],
    default: [],
  },
  subtotalCents: { type: Number, required: true },
  taxCents: { type: Number, default: 0 },
  totalCents: { type: Number, required: true },
  currency: { type: String, default: 'usd' },

  // Snapshot of billing details AT THE TIME the invoice was issued, so a
  // later profile/address edit never rewrites what a historical invoice
  // says — the same reason real invoicing systems never "live join" this.
  billTo: {
    companyName: String,
    contactName: String,
    email: String,
    address: addressSchema,
  },

  generatedBy: {
    type: String,
    enum: ['cron', 'manual', 'plan_change'],
    default: 'cron',
  },
}, {
  timestamps: true,
});

invoiceSchema.index({ tenantId: 1, issuedAt: -1 });
invoiceSchema.index({ tenantId: 1, periodStart: 1 });
invoiceSchema.index({ tenantId: 1, invoiceNumber: 1 }, { unique: true });

module.exports = mongoose.model('Invoice', invoiceSchema);
