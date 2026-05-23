/**
 * Cross-module utilities and identity checks. See spec §10.1, §1.5.
 */

/**
 * Membership test for any Rail-Node. See §10.1.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRailNode(value) {
  return Boolean(value) && typeof value === 'object' && value.__rail_type__ === 'node';
}

/**
 * "Plain object" test per §1.5 — used by builder argument validation.
 * Rejects null, Array, Map, Set, Date, RegExp, and similar built-ins.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  if (value instanceof Map || value instanceof Set) return false;
  if (value instanceof Date || value instanceof RegExp) return false;
  if (value instanceof Promise) return false;
  return true;
}
