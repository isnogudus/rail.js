/**
 * Error classes for rail.js v0.3.0. See spec §12.
 *
 * Single hierarchy rooted at `RailError`:
 *   RailError
 *   ├── RailBuildError       (build-time validation, §12.2)
 *   ├── RailRuntimeError     (runtime failures, §12.1)
 *   └── RailAggregateError   (parallel branch failure aggregate, §12.4)
 *
 * `err instanceof RailError` is the single membership test for any
 * library-produced error.
 */

export class RailError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RailError';
  }
}

function composeMessage(code, options) {
  if (options && typeof options.message === 'string') return options.message;
  const parts = [code];
  if (options?.details) {
    try {
      parts.push(JSON.stringify(options.details));
    } catch {
      /* ignore non-serialisable details */
    }
  }
  if (options?.cause && options.cause.message) {
    parts.push(`cause: ${options.cause.message}`);
  }
  return parts.join(' ');
}

export class RailBuildError extends RailError {
  constructor(code, options) {
    super(composeMessage(code, options));
    this.name = 'RailBuildError';
    this.code = code;
    if (options?.details !== undefined) this.details = options.details;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

export class RailRuntimeError extends RailError {
  constructor(code, options) {
    super(composeMessage(code, options));
    this.name = 'RailRuntimeError';
    this.code = code;
    if (options?.flowName !== undefined) this.flowName = options.flowName;
    if (options?.details !== undefined) this.details = options.details;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

export class RailAggregateError extends RailError {
  constructor(branchErrors) {
    const keys = Object.keys(branchErrors);
    const message = `${keys.length} branch(es) failed: ${keys.join(', ')}`;
    super(message);
    this.name = 'RailAggregateError';
    this.code = 'PARALLEL_BRANCH_FAILED';
    this.branchErrors = branchErrors;
    this.errors = Object.values(branchErrors);
  }
}

/**
 * Validates a user-supplied name per spec §5.1.
 * Raises RailBuildError(INVALID_NAME) synchronously on violation.
 *
 * Rules: non-empty string, not whitespace-only, no `.`.
 *
 * @param {unknown} name
 * @param {string} where  short location label for the error details
 * @param {object} [extra] extra fields merged into details
 */
export function validateName(name, where, extra) {
  if (typeof name !== 'string' || name.length === 0 || /^\s*$/.test(name)) {
    throw new RailBuildError('INVALID_NAME', {
      message: `${where}: name must be a non-empty, non-whitespace string`,
      details: { where, name, ...extra },
    });
  }
  if (name.includes('.')) {
    throw new RailBuildError('INVALID_NAME', {
      message: `${where}: name "${name}" contains reserved character "."`,
      details: { where, name, ...extra },
    });
  }
}
