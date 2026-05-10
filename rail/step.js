/**
 * `node(fn, options)` — Step-Node factory. See spec §3.2, §11.
 *
 * A Step-Node wraps a user function. It has no intrinsic name; the
 * name is given by the call site that adds it to a flow or activity.
 */

import { RailCompileError, RailRuntimeError } from './errors.js';

/**
 * @typedef {object} StepOptions
 * @property {string[]} [inputs]
 * @property {string[]} outputs
 */

/**
 * @typedef {object} StepNode
 * @property {'step'} railKind
 * @property {string[]} inputs
 * @property {string[]} outputs
 * @property {() => void} compile
 * @property {() => boolean} compiled
 * @property {(name: string, ctx: object, runState: object) => Promise<{output: string, ctx?: object}>} invoke
 */

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

/**
 * Creates a Step-Node from a user function.
 *
 * @param {(ctx: object, runInfo?: {signal?: AbortSignal, input: string}) =>
 *           (string | {output: string, ctx?: object} |
 *            Promise<string | {output: string, ctx?: object}>)} fn
 * @param {StepOptions} options
 * @returns {StepNode}
 */
export function node(fn, options) {
  if (typeof fn !== 'function') {
    throw new TypeError(`node(fn, opts): fn must be a function, got ${typeof fn}`);
  }
  if (!options || typeof options !== 'object') {
    throw new TypeError('node(fn, opts): opts is required');
  }

  const inputs = Array.isArray(options.inputs) ? options.inputs.slice() : ['in'];
  const outputs = Array.isArray(options.outputs) ? options.outputs.slice() : options.outputs;

  /** @type {StepNode & { _fn: Function, _compiled: boolean }} */
  const step = {
    railKind: 'step',
    inputs,
    outputs: /** @type {any} */ (outputs),
    _fn: fn,
    _compiled: false,

    compile() {
      if (step._compiled) return;
      /** @type {Array<object>} */
      const errors = [];
      validatePorts(step.outputs, 'outputs', errors);
      validatePorts(step.inputs, 'inputs', errors);
      if (errors.length > 0) {
        throw new RailCompileError('declaration', errors);
      }
      step._compiled = true;
    },

    compiled() {
      return step._compiled;
    },

    async invoke(name, ctx, runState) {
      const runInfo = {
        signal: runState.combinedSignal,
        input: runState.currentInput,
      };
      const result = await step._fn(ctx, runInfo);
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
    },
  };

  return step;
}
