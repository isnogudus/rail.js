/**
 * Typed-ctx helpers + isRailNode. See spec §3.9, §3.12.
 *
 * The library follows a lightweight convention: a ctx object marked
 * with `__type: '<name>'` declares its shape. Library uses
 * `'exception'` and `'parallel-results'` internally; user code may
 * introduce its own types.
 */

/**
 * @param {unknown} value
 * @returns {boolean} true iff value looks like a Rail-Node
 *   (`typeof value?.railKind === 'string'`).
 */
export function isRailNode(value) {
  return typeof (/** @type {any} */ (value)?.railKind) === 'string';
}

/**
 * Constructs an exception ctx (typed-ctx with `__type: 'exception'`).
 *
 * Used by step code that catches an exception and wants downstream
 * code to inspect it as structured data. Stores `inputCtx` and
 * `error` by reference — no cloning.
 *
 * @param {unknown} err       The caught error (or any error-like value).
 * @param {object}  inputCtx  The ctx the step was invoked with.
 * @returns {{__type: 'exception', inputCtx: object, error: unknown}}
 */
export function exceptionCtx(err, inputCtx) {
  return { __type: 'exception', inputCtx, error: err };
}

/**
 * @param {unknown} value
 * @returns {boolean} true iff `value?.__type === 'exception'`.
 */
export function isExceptionCtx(value) {
  return /** @type {any} */ (value)?.__type === 'exception';
}

/**
 * @param {unknown} value
 * @returns {boolean} true iff `value?.__type === 'parallel-results'`.
 */
export function isParallelCtx(value) {
  return /** @type {any} */ (value)?.__type === 'parallel-results';
}

/**
 * Generic typed-ctx accessor.
 *
 * @param {unknown} value
 * @returns {string|undefined} `value.__type` if it is a string, else undefined.
 */
export function ctxType(value) {
  const t = /** @type {any} */ (value)?.__type;
  return typeof t === 'string' ? t : undefined;
}
