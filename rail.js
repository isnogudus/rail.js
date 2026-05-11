/**
 * rail.js — public API.
 *
 * A small workflow library: explicit, validated graphs of named
 * steps. Plain ES modules with JSDoc, no runtime dependencies.
 *
 * See docs/rail-spec.md for the full specification.
 */

export { node } from './rail/step.js';
export { activity } from './rail/activity.js';
export { parallel } from './rail/parallel.js';
export { merge } from './rail/merge.js';
export { catching } from './rail/catching.js';
export { flow } from './rail/flow.js';

export {
  isRailNode,
  exceptionCtx,
  isExceptionCtx,
  isParallelCtx,
  ctxType,
} from './rail/ctx.js';

export {
  RailBuildError,
  RailCheckError,
  RailRuntimeError,
} from './rail/errors.js';
