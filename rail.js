/**
 * rail.js v0.3.0 — public API.
 *
 * A small workflow library: explicit, validated graphs of named
 * nodes with named outputs. Plain ES modules + JSDoc, no runtime
 * dependencies, no build step.
 *
 * See docs/rail-spec.md for the full specification.
 */

// Atomic builders (§3) and the user-function-level catch wrapper (§11).
export { atom, nstep, step, pass, fail, catchTo } from './rail/atomic.js';

// Wrapper builder (§4).
export { pin } from './rail/pin.js';

// Group builders (§5, §6, §7, §8).
export { activity } from './rail/activity.js';
export { nrail, railway } from './rail/nrail.js';
export { parallel } from './rail/parallel.js';

// Flow (§9).
export { flow } from './rail/flow.js';

// Utilities (§10).
export { isRailNode } from './rail/util.js';

// Extension API: invokeNode is exported for custom-kind authors (§2, §15.3).
export { invokeNode } from './rail/runtime.js';

// Errors (§12).
export {
  RailError,
  RailBuildError,
  RailRuntimeError,
  RailAggregateError,
} from './rail/errors.js';
