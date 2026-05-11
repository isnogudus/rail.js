/**
 * `node(fn, options)` — Step-Node factory. See spec §3.2, §11.
 *
 * A Step-Node wraps a user function. It has no intrinsic name; the
 * name is given by the call site that adds it to a flow or activity.
 *
 * Implementation: each Step-Node is `Object.create(STEP_PROTO)` with
 * per-instance state (`inputs`, `outputs`, `_fn`, `_checked`). The
 * methods on STEP_PROTO are shared across all Step-Nodes — they
 * dispatch to module-level helpers via `this`.
 */

import { RailCheckError, RailRuntimeError, validateName } from './errors.js';

/**
 * @typedef {object} StepOptions
 * @property {string[]} [inputs]
 * @property {string[]} outputs
 */

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Validates an inputs / outputs port array structurally (empty +
 * duplicates). Per-name validation (`INVALID_NAME`) already happened
 * eagerly in the factory. Pushes issues to `errors`.
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
  for (const p of arr) {
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

function checkStep(node) {
  if (node._checked) return;
  const errors = [];
  validatePorts(node.outputs, 'outputs', errors);
  validatePorts(node.inputs, 'inputs', errors);
  if (errors.length > 0) {
    throw new RailCheckError('declaration', errors);
  }
  node._checked = true;
}

/**
 * Invokes the user function and translates its StepReturn into the
 * uniform invoke-contract shape.
 *
 * The `local` parameter is the position-local state read by the
 * step-execution loop. The user function receives it as its second
 * argument; if the user returns a `local` field, this invoke passes
 * it back up so the runner can store it.
 *
 * @param {object} node
 * @param {string} name
 * @param {object} ctx
 * @param {object} runState
 * @param {object} local
 */
async function invokeStep(node, name, ctx, runState, local) {
  const shared = runState.shared;
  const runInfo = {
    signal: runState.combinedSignal,
    input: runState.currentInput,
    invocation: runState.invocation,
    path: runState.fullPath ?? runState.path,
  };
  const result = await node._fn(ctx, local, runInfo);
  if (typeof result === 'string') {
    return { output: result };
  }
  if (result && typeof result === 'object' && typeof result.output === 'string') {
    return result;
  }
  throw new RailRuntimeError(
    'INVALID_SUB_NODE',
    `Step "${name}" returned invalid value: expected string or { output, ctx?, local? }`,
    {
      flow: shared.flowName,
      trace: shared.trace,
      ctx,
    }
  );
}

/* ------------------------------------------------------------------ */
/* Shared prototype                                                   */
/* ------------------------------------------------------------------ */

// Not frozen: instances may shadow methods (useful for tests that
// wrap check/invoke). Treat the prototype as conceptually constant
// — nothing in the library writes to it.
const STEP_PROTO = {
  railKind: 'step',
  check()    { return checkStep(this); },
  isChecked() { return this._checked; },
  invoke(name, ctx, runState, local) {
    return invokeStep(this, name, ctx, runState, local);
  },
};

/* ------------------------------------------------------------------ */
/* Factory                                                            */
/* ------------------------------------------------------------------ */

/**
 * Creates a Step-Node from a user function.
 *
 * @param {(ctx: object, local?: object, runInfo?: object) =>
 *           (string | {output: string, ctx?: object, local?: object} |
 *            Promise<string | {output: string, ctx?: object, local?: object}>)} fn
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

  const inputs  = Array.isArray(options.inputs)  ? options.inputs.slice()  : ['in'];
  const outputs = Array.isArray(options.outputs) ? options.outputs.slice() : options.outputs;

  // Per-name eager validation. Empty/duplicates structural checks
  // are deferred to check() (§7.2 step-node self-check).
  if (Array.isArray(inputs)) {
    for (const p of inputs) validateName(p, 'node(): input', { input: p });
  }
  if (Array.isArray(outputs)) {
    for (const p of outputs) validateName(p, 'node(): output', { output: p });
  }

  const step = Object.create(STEP_PROTO);
  step.inputs   = inputs;
  step.outputs  = outputs;
  step._fn       = fn;
  step._checked = false;
  return step;
}
