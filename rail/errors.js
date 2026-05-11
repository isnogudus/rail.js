/**
 * Error classes for rail.js. See spec §5 and §7.
 *
 * - `RailBuildError` — synchronous validation at builder time (§7.1, §5.4).
 *   Raised by builder methods (`a.wire`, `a.addNode`, ...), factories
 *   (`node`, `parallel`, `flow`, `catching`), and handle methods
 *   (`.out`, `.in`). The stack trace points at the offending line.
 * - `RailCheckError` — two-phase activity check (§7.2-7.4) and node-level
 *   structural checks. Carries a `phase` and a list of `errors`.
 * - `RailRuntimeError` — failures at run-time (§5.3).
 */

/**
 * Builder/pre-execution validation error.
 *
 * Raised synchronously at the call site (e.g. inside `a.wire(...)`,
 * `nodeHandle.out(...)`, `flow(...)`, `catching(...)`).
 *
 * @extends Error
 */
export class RailBuildError extends Error {
  /**
   * @param {string} code   One of the codes listed in spec §5.4.
   * @param {string} message Human-readable message.
   * @param {Record<string, unknown>} [fields] Extra fields per code.
   */
  constructor(code, message, fields = {}) {
    super(message);
    this.name = 'RailBuildError';
    this.code = code;
    Object.assign(this, fields);
  }
}

/**
 * Post-builder validation error.
 *
 * Raised by `node.check()` when one of the phases (completeness /
 * topology for activities; structural for step-/parallel-nodes)
 * reports issues.
 *
 * @extends Error
 */
export class RailCheckError extends Error {
  /**
   * @param {'declaration'|'completeness'|'topology'} phase
   * @param {Array<{code: string, suggestion?: string} & Record<string, unknown>>} errors
   * @param {string} [message]
   */
  constructor(phase, errors, message) {
    super(message ?? `Node check failed in phase '${phase}' with ${errors.length} error(s)`);
    this.name = 'RailCheckError';
    this.phase = phase;
    this.errors = errors;
  }
}

/**
 * Runtime error.
 *
 * Always carries the run's accumulated trace and the ctx that was
 * current when the error was raised.
 *
 * @extends Error
 */
export class RailRuntimeError extends Error {
  /**
   * @param {string} code  One of the codes listed in spec §5.3.
   * @param {string} message
   * @param {object} info
   * @param {string} info.flow                Top-level flow name.
   * @param {Array<object>} info.trace        Trace entries up to the failure.
   * @param {object} info.ctx                 Ctx state at failure.
   * @param {Error} [info.cause]              Original error, if wrapping.
   */
  constructor(code, message, { flow, trace, ctx, cause } = {}) {
    super(message);
    this.name = 'RailRuntimeError';
    this.code = code;
    this.flow = flow;
    this.trace = trace ?? [];
    this.ctx = ctx ?? {};
    if (cause !== undefined) this.cause = cause;
  }
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Validates a user-supplied name (node, port, entry, exit, branch,
 * flow). Raises `RailBuildError(INVALID_NAME)` synchronously if the
 * name is empty, whitespace-only, or contains a reserved character
 * (`.` or `:`). See spec §3.3.
 *
 * @param {unknown} name
 * @param {string} context  Short description for error messages (e.g.
 *                          "a.entry(name)", "node output").
 * @param {Record<string, unknown>} [fields] Extra fields on the error.
 */
export function validateName(name, context, fields = {}) {
  if (typeof name !== 'string' || name.length === 0 || /^\s*$/.test(name)) {
    throw new RailBuildError(
      'INVALID_NAME',
      `${context}: name must be a non-empty, non-whitespace string`,
      { name, ...fields }
    );
  }
  if (name.includes('.') || name.includes(':')) {
    throw new RailBuildError(
      'INVALID_NAME',
      `${context}: name "${name}" contains reserved character (".", ":")`,
      { name, ...fields }
    );
  }
}
