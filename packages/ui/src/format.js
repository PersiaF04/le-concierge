/**
 * Formatting shared by the three surfaces.
 *
 * Plain JS with JSDoc types so `node --test` can import it without a build step;
 * Vite reads the same file for the apps.
 */

/** @param {string|number|Date} value */
export function formatTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** Whole seconds as the resident reads them: "28s", "0s". */
export function secondsLabel(seconds) {
  const whole = Math.max(0, Math.round(Number(seconds) || 0));
  return `${whole}s`;
}

/** The word stamped on a visit, per status. */
export function stampFor(status) {
  switch (status) {
    case "approved":
      return "approved";
    case "declined":
      return "declined";
    case "expired":
      return "no answer";
    case "pending_decision":
      return "awaiting signature";
    case "arriving":
      return "arriving";
    default:
      return "recorded";
  }
}

/** Confidence as a percentage a person can read. */
export function confidenceLabel(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return `${Math.round(number * 100)}%`;
}

/** Descriptor distance, three decimals, or an em dash when nobody matched. */
export function distanceLabel(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "no match";
  return Number(value).toFixed(2);
}

/** Audio size in bytes, with the thousands separator a person expects. */
export function bytesLabel(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "—";
  return `${number.toLocaleString("en-GB")} bytes`;
}

/** A latency that reads the same whether it arrived in milliseconds or seconds. */
export function msLabel(value) {
  if (value === null || value === undefined) return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  if (number >= 1000) return `${(number / 1000).toFixed(2)} s`;
  return `${Math.round(number)} ms`;
}
