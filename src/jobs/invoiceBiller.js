/**
 * Monthly invoice generator.
 *
 * There is no real payment gateway wired up (see utils/invoices.js), so
 * this does not charge anyone — it just records, once per tenant per
 * calendar month, what they owe for their current storage plan, so the
 * Invoices page has real billing-history rows to show.
 *
 * Runs a check every day rather than only on the 1st, so a tenant still
 * gets billed for the month even if the server happened to be down when
 * the 1st rolled around. This is safe to run repeatedly: for each tenant
 * it first checks whether an invoice already exists for the current
 * calendar month and skips if so, so nobody is ever double-billed.
 *
 * Tenants on an annual enterprise plan (billingCycle 'yearly') are
 * skipped entirely — they're billed once a year, not monthly, and
 * jobs/enterpriseSubscriptionExpiry.js is what watches their renewal
 * instead of this job.
 */
const cron = require('node-cron');
const User = require('../models/User');
const Invoice = require('../models/Invoice');
const { createInvoiceForTenant } = require('../utils/invoices');
const { getTenantStorageSummary } = require('../utils/tenantStorage');
const logger = require('../utils/logger');

const generateMonthlyInvoices = async () => {
  try {
    const tenantIds = await User.distinct('tenantId', {
      isActive: true,
      tenantId: { $exists: true, $ne: null },
    });

    if (!tenantIds.length) return;

    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    for (const tenantId of tenantIds) {
      const alreadyBilled = await Invoice.exists({ tenantId, periodStart });
      if (alreadyBilled) continue;

      const tenantStorage = await getTenantStorageSummary(tenantId);
      if (tenantStorage.billingCycle === 'yearly') continue;

      try {
        const invoice = await createInvoiceForTenant(tenantId, {
          periodStart,
          periodEnd,
          generatedBy: 'cron',
        });
        logger.info(
          `[invoiceBiller] Generated ${invoice.invoiceNumber} for tenant ${tenantId} `
          + `(${(invoice.totalCents / 100).toFixed(2)} ${invoice.currency}).`
        );
      } catch (err) {
        logger.error(`[invoiceBiller] Failed to generate invoice for tenant ${tenantId}:`, err.message);
      }
    }
  } catch (err) {
    logger.error('[invoiceBiller] Error during monthly invoice generation:', err.message);
  }
};

const startInvoiceBiller = () => {
  // Run once on startup to catch any tenant not yet billed this month.
  generateMonthlyInvoices();
  // Then check daily at 03:00 — the periodStart guard above keeps this
  // idempotent, so each tenant only ever gets one invoice per month.
  cron.schedule('0 3 * * *', generateMonthlyInvoices);
  logger.info('[invoiceBiller] Scheduled monthly invoice generation (checked daily at 03:00).');
};

module.exports = { startInvoiceBiller, generateMonthlyInvoices };
