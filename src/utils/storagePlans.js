const GB_IN_BYTES = 1024 * 1024 * 1024;

// Single source of truth for the enterprise storage/subscription plans.
// Add a plan here and it automatically becomes selectable everywhere
// (admin controls, self-service billing page, validation).
//
// priceUsdPerMonth is the real advertised price, but no payment processor
// is wired up yet (see billingController.js / utils/invoices.js) — these
// numbers only drive the self-contained invoice ledger, not actual charges.
const STORAGE_PLANS = [
  {
    id: 'starter',
    name: 'Starter',
    storageGb: 50,
    billingCycle: 'monthly',
    priceUsdPerMonth: 15,
    features: [
      '50 GB shared enterprise storage pool',
      'Real-time collaboration',
      'Version history (30 days)',
      'Up to 5 team members',
      'Email support',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    storageGb: 100,
    billingCycle: 'monthly',
    priceUsdPerMonth: 25,
    popular: true,
    features: [
      '100 GB shared enterprise storage pool',
      'Real-time collaboration',
      'Version history (90 days)',
      'Up to 20 team members',
      'Priority email support',
      'Advanced analytics',
    ],
  },
  {
    id: 'business',
    name: 'Business',
    storageGb: 200,
    billingCycle: 'monthly',
    priceUsdPerMonth: 40,
    features: [
      '200 GB shared enterprise storage pool',
      'Real-time collaboration',
      'Unlimited version history',
      'Unlimited team members',
      '24/7 priority support',
      'Advanced analytics',
      'Custom integrations',
    ],
  },
  {
    id: 'growth',
    name: 'Growth',
    storageGb: 500,
    billingCycle: 'monthly',
    priceUsdPerMonth: 50,
    features: [
      '500 GB shared enterprise storage pool',
      'Real-time collaboration',
      'Unlimited version history',
      'Unlimited team members',
      '24/7 priority support',
      'Advanced analytics',
      'Custom integrations',
    ],
  },
  {
    id: 'scale',
    name: 'Scale',
    storageGb: 1000,
    billingCycle: 'monthly',
    priceUsdPerMonth: 65,
    features: [
      '1 TB shared enterprise storage pool',
      'Real-time collaboration',
      'Unlimited version history',
      'Unlimited team members',
      '24/7 priority support',
      'Advanced analytics',
      'Custom integrations',
      'Dedicated success manager',
    ],
  },
  // Annual enterprise tiers — assigned manually by an admin from the
  // storage-management panel after an enterprise client reaches out via
  // the contact page (see adminController.updateEnterpriseStorage). Unlike
  // the monthly plans above, these bill once a year: assigning one sets
  // currentPeriodStart/currentPeriodEnd on the tenant's users, and
  // jobs/enterpriseSubscriptionExpiry.js watches currentPeriodEnd to flag
  // renewals and expirations for the admin to follow up on.
  {
    id: 'enterprise-1tb-annual',
    name: 'Enterprise 1TB (Annual)',
    storageGb: 1000,
    billingCycle: 'yearly',
    priceUsdPerYear: 125,
    features: [
      '1 TB shared enterprise storage pool',
      'Billed once per year ($125/year)',
      'Real-time collaboration',
      'Unlimited version history',
      'Unlimited team members',
      '24/7 priority support',
      'Advanced analytics',
      'Custom integrations',
      'Dedicated success manager',
    ],
  },
  {
    id: 'enterprise-2tb-annual',
    name: 'Enterprise 2TB (Annual)',
    storageGb: 2000,
    billingCycle: 'yearly',
    priceUsdPerYear: 250,
    features: [
      '2 TB shared enterprise storage pool',
      'Billed once per year ($250/year)',
      'Real-time collaboration',
      'Unlimited version history',
      'Unlimited team members',
      '24/7 priority support',
      'Advanced analytics',
      'Custom integrations',
      'Dedicated success manager',
    ],
  },
];

// De-duplicated: the annual enterprise tiers intentionally reuse the same
// storageGb as an existing monthly plan (1 TB), so a plain GB lookup can't
// tell them apart on its own — callers that need to distinguish billing
// cycle should resolve by `id` via findPlanById instead.
const STORAGE_PLAN_GB_OPTIONS = [...new Set(STORAGE_PLANS.map((plan) => plan.storageGb))];

const ANNUAL_STORAGE_PLANS = STORAGE_PLANS.filter((plan) => plan.billingCycle === 'yearly');

const findPlanById = (planId) => STORAGE_PLANS.find((plan) => plan.id === planId) || null;

const gbToBytes = (gb) => Number(gb) * GB_IN_BYTES;

const bytesToGb = (bytes) => Math.round(Number(bytes) / GB_IN_BYTES);

module.exports = {
  GB_IN_BYTES,
  STORAGE_PLANS,
  ANNUAL_STORAGE_PLANS,
  STORAGE_PLAN_GB_OPTIONS,
  findPlanById,
  gbToBytes,
  bytesToGb,
};
