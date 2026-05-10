/**
 * Error classes for rail.js. See spec §5 and §7.
 *
 * - `RailBuildError` — synchronous validation at build/wire time (per §3.3, §5.4).
 * - `RailCompileError` — three-phase activity validation (§7).
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
 * Compile-time validation error.
 *
 * Raised by `Activity.compile()` when one of the three phases
 * (declaration / completeness / topology) reports issues.
 *
 * @extends Error
 */
export class RailCompileError extends Error {
  /**
   * @param {'declaration'|'completeness'|'topology'} phase
   * @param {Array<{code: string, suggestion?: string} & Record<string, unknown>>} errors
   * @param {string} [message]
   */
  constructor(phase, errors, message) {
    super(message ?? `Activity compile failed in phase '${phase}' with ${errors.length} error(s)`);
    this.name = 'RailCompileError';
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
