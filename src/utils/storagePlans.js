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
];

const STORAGE_PLAN_GB_OPTIONS = STORAGE_PLANS.map((plan) => plan.storageGb);

const gbToBytes = (gb) => Number(gb) * GB_IN_BYTES;

const bytesToGb = (bytes) => Math.round(Number(bytes) / GB_IN_BYTES);

module.exports = {
  GB_IN_BYTES,
  STORAGE_PLANS,
  STORAGE_PLAN_GB_OPTIONS,
  gbToBytes,
  bytesToGb,
};
