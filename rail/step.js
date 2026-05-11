/**
 * `node(fn, options)` — Step-Node factory. See spec §3.2, §11.
 *
 * A Step-Node wraps a user function. It has no intrinsic name; the
 * name is given by the call site that adds it to a flow or activity.
 *
 * Implementation: each Step-Node is `Object.create(STEP_PROTO)` with
 * per-instance state (`inputs`, `outputs`, `_fn`, `_compiled`). The
 * methods on STEP_PROTO are shared across all Step-Nodes — they
 * dispatch to module-level helpers via `this`.
 */

import { RailCompileError, RailRuntimeError } from './errors.js';

/**
 * @typedef {object} StepOptions
 * @property {string[]} [inputs]
 * @property {string[]} outputs
 */

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Validates an inputs / outputs port array. Pushes phase-A-style
 * issues to `errors`.
 *
 * @param {string[]|undefined} arr
 * @param {'inputs'|'outputs'} kind
 * @param {Array<object>} errors
 */
function validatePorts(arr, kind, errors) {
  const emptyCode = kind === 'outputs' ? 'EMPTY_OUTPUTS' : 'EMPTY_INPUTS';
  const dupCode = kind === 'outputs' ? 'DUPLICATE_OUTPUT' : 'DUPLICATE_INPUT';
  if (!Array.isArray(arr) || arr.length === 0) {
    errors.push({ code: emptyCode });
    return;
  }
  const seen = new Set();
  let hadInvalid = false;
  for (const p of arr) {
    if (typeof p !== 'string' || p.length === 0) {
      if (!hadInvalid) errors.push({ code: emptyCode });
      hadInvalid = true;
      continue;
    }
    if (seen.has(p)) {
      errors.push({ code: dupCode, [kind === 'outputs' ? 'output' : 'input']: p });
    } else {
      seen.add(p);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Module-level operations on a Step-Node                             */
/* ------------------------------------------------------------------ */

function compileStep(node) {
  if (node._compiled) return;
  const errors = [];
  validatePorts(node.outputs, 'outputs', errors);
  validatePorts(node.inputs, 'inputs', errors);
  if (errors.length > 0) {
    throw new RailCompileError('declaration', errors);
  }
  node._compiled = true;
}

async function invokeStep(node, name, ctx, runState) {
  const runInfo = {
    signal: runState.combinedSignal,
    input: runState.currentInput,
  };
  const result = await node._fn(ctx, runInfo);
  if (typeof result === 'string') {
    return { output: result };
  }
  if (result && typeof result === 'object' && typeof result.output === 'string') {
    return result;
  }
  throw new RailRuntimeError(
    'INVALID_SUB_NODE',
    `Step "${name}" returned invalid value: expected string or { output, ctx? }`,
    {
      flow: runState.shared.flowName,
      trace: runState.shared.trace,
      ctx,
    }
  );
}

/* ------------------------------------------------------------------ */
/* Shared prototype                                                   */
/* ------------------------------------------------------------------ */

// Not frozen: instances may shadow methods (useful for tests that
// wrap compile/invoke). Treat the prototype as conceptually constant
// — nothing in the library writes to it.
const STEP_PROTO = {
  railKind: 'step',
  compile()  { return compileStep(this); },
  compiled() { return this._compiled; },
  invoke(name, ctx, runState) { return invokeStep(this, name, ctx, runState); },
};

/* ------------------------------------------------------------------ */
/* Factory                                                            */
/* ------------------------------------------------------------------ */

/**
 * Creates a Step-Node from a user function.
 *
 * @param {(ctx: object, runInfo?: {signal?: AbortSignal, input: string}) =>
 *           (string | {output: string, ctx?: object} |
 *            Promise<string | {output: string, ctx?: object}>)} fn
 * @param {StepOptions} options
 * @returns {object} A Rail-Node with `railKind: 'step'`.
 */
export function node(fn, options) {
  if (typeof fn !== 'function') {
    throw new TypeError(`node(fn, opts): fn must be a function, got ${typeof fn}`);
  }
  if (!options || typeof options !== 'object') {
    throw new TypeError('node(fn, opts): opts is required');
  }

  const step = Object.create(STEP_PROTO);
  step.inputs   = Array.isArray(options.inputs) ? options.inputs.slice() : ['in'];
  step.outputs  = Array.isArray(options.outputs) ? options.outputs.slice() : options.outputs;
  step._fn       = fn;
  step._compiled = false;
  return step;
}
