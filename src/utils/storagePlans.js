const GB_IN_BYTES = 1024 * 1024 * 1024;
const STORAGE_PLAN_GB_OPTIONS = [50, 100, 200];

const gbToBytes = (gb) => Number(gb) * GB_IN_BYTES;

const bytesToGb = (bytes) => Math.round(Number(bytes) / GB_IN_BYTES);

module.exports = {
  GB_IN_BYTES,
  STORAGE_PLAN_GB_OPTIONS,
  gbToBytes,
  bytesToGb,
};