const Invoice = require('../models/Invoice');
const Tenant = require('../models/Tenant');
const User = require('../models/User');
const { STORAGE_PLANS } = require('./storagePlans');
const { getTenantStorageSummary } = require('./tenantStorage');

// No tax jurisdiction or rate data is tracked anywhere in the app yet
// (no billing address collection, no tax API integration), so every
// invoice is generated with 0% tax rather than guessing a number.
// Revisit this once real billing addresses + tax rules exist.
const TAX_RATE_PERCENT = 0;

// billingCycle disambiguates plans that share a storageGb — e.g. the 1 TB
// "Scale" monthly plan and the "Enterprise 1TB (Annual)" plan — so a
// yearly tenant doesn't get billed at the wrong (monthly) plan's price.
const findPlanByStorageGb = (storageGb, billingCycle = 'monthly') => (
  STORAGE_PLANS.find((plan) => plan.storageGb === Number(storageGb) && plan.billingCycle === billingCycle)
    || STORAGE_PLANS.find((plan) => plan.storageGb === Number(storageGb))
    || STORAGE_PLANS[0]
);

// Sequential, human-readable invoice numbers scoped per tenant, e.g.
// "INV-ACME-000001". Not strictly race-condition-proof under concurrent
// generation for the same tenant, but invoices are only ever created by
// one cron pass or one manual click at a time in practice.
const generateInvoiceNumber = async (tenantId) => {
  const count = await Invoice.countDocuments({ tenantId });
  const tenantPrefix = String(tenantId)
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 4)
    .toUpperCase()
    .padEnd(4, 'X');
  return `INV-${tenantPrefix}-${String(count + 1).padStart(6, '0')}`;
};

// Snapshot of who the invoice is billed to, at generation time.
const buildBillToSnapshot = async (tenantId) => {
  const tenant = await Tenant.findOne({ tenantId }).populate('adminUser');
  let contactUser = tenant?.adminUser || null;

  if (!contactUser) {
    contactUser = (await User.findOne({ tenantId, role: 'Admin' }))
      || (await User.findOne({ tenantId }).sort({ createdAt: 1 }));
  }

  const contactName = contactUser ? `${contactUser.firstName} ${contactUser.lastName}`.trim() : '';

  return {
    companyName: tenant?.name || contactName || 'Customer',
    contactName,
    email: tenant?.billing?.email || contactUser?.email || '',
    address: tenant?.billing?.address || {},
  };
};

/**
 * Creates one invoice record for a tenant's *current* plan. This does not
 * charge any card — see the note in models/Invoice.js — it only records
 * what the tenant owes for the given billing period.
 */
const createInvoiceForTenant = async (tenantId, { periodStart, periodEnd, generatedBy = 'cron' } = {}) => {
  const storageSummary = await getTenantStorageSummary(tenantId);
  const plan = findPlanByStorageGb(storageSummary.storagePlanGb, storageSummary.billingCycle);
  const isAnnual = plan.billingCycle === 'yearly';

  const now = new Date();
  const resolvedPeriodEnd = periodEnd
    || (isAnnual ? storageSummary.currentPeriodEnd : null)
    || now;
  const resolvedPeriodStart = periodStart
    || (isAnnual ? storageSummary.currentPeriodStart : null)
    || new Date(resolvedPeriodEnd.getFullYear(), resolvedPeriodEnd.getMonth(), 1);

  const unitAmountCents = Math.round(
    Number((isAnnual ? plan.priceUsdPerYear : plan.priceUsdPerMonth) || 0) * 100
  );
  const lineItems = [{
    description: `${plan.name} plan — ${plan.storageGb} GB shared enterprise storage `
      + `(${isAnnual ? 'annual' : 'monthly'})`,
    quantity: 1,
    unitAmountCents,
    amountCents: unitAmountCents,
  }];

  const subtotalCents = lineItems.reduce((sum, item) => sum + item.amountCents, 0);
  const taxCents = Math.round(subtotalCents * (TAX_RATE_PERCENT / 100));
  const totalCents = subtotalCents + taxCents;

  const [invoiceNumber, billTo] = await Promise.all([
    generateInvoiceNumber(tenantId),
    buildBillToSnapshot(tenantId),
  ]);

  return Invoice.create({
    tenantId,
    invoiceNumber,
    status: 'paid',
    planId: plan.id,
    planName: plan.name,
    storageGb: plan.storageGb,
    periodStart: resolvedPeriodStart,
    periodEnd: resolvedPeriodEnd,
    issuedAt: now,
    lineItems,
    subtotalCents,
    taxCents,
    totalCents,
    currency: 'usd',
    billTo,
    generatedBy,
  });
};

module.exports = {
  TAX_RATE_PERCENT,
  findPlanByStorageGb,
  generateInvoiceNumber,
  buildBillToSnapshot,
  createInvoiceForTenant,
};
