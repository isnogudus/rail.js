/**
 * Atomic builders for rail.js v0.3.0. See spec §3, §11.
 *
 * Exports:
 *   atom(fn, options)         — primitive atomic builder
 *   nstep(fn, inputs, outputs) — string-or-array + nullish-return convenience
 *   step(fn)                  — catchTo-wrapped: success/failure
 *   pass(fn)                  — catchTo-wrapped: success only
 *   fail(fn)                  — catchTo-wrapped: failure only
 *   catchTo(fn, exitName)     — user-function-level catch wrapper
 *
 * All five builders produce nodes with `__rail_kind__: 'atom'`.
 */

import {
  RailBuildError,
  RailError,
  RailRuntimeError,
  validateName,
} from './errors.js';
import { invokeNode } from './runtime.js';
import { isPlainObject } from './util.js';

/**
 * User-function-level wrapper for opt-in throw-to-exit routing. See §11.
 *
 * On non-library throw: sets `ctx._error = err` and returns `exitName`.
 * On library throw (RailError or subclass): re-throws unchanged.
 *
 * @template T
 * @param {(ctx: object, local: object, runInfo: object) => T} fn
 * @param {string} exitName
 * @returns {(ctx: object, local: object, runInfo: object) => Promise<T | string>}
 */
export function catchTo(fn, exitName) {
  return async function catchToWrapped(ctx, local, runInfo) {
    try {
      return await fn(ctx, local, runInfo);
    } catch (err) {
      if (err instanceof RailError) throw err;
      ctx._error = err;
      return exitName;
    }
  };
}

function validatePortList(ports, role, where) {
  if (!Array.isArray(ports) || ports.length === 0) {
    throw new RailBuildError(
      role === 'inputs' ? 'MISSING_INPUTS' : 'MISSING_OUTPUTS',
      {
        message: `${where}: ${role} must be a non-empty array`,
        details: { where, role, value: ports },
      },
    );
  }
  const seen = new Set();
  for (const p of ports) {
    validateName(p, `${where}: ${role}`, { role });
    if (seen.has(p)) {
      throw new RailBuildError(
        role === 'inputs' ? 'DUPLICATE_INPUT' : 'DUPLICATE_OUTPUT',
        {
          message: `${where}: duplicate ${role.slice(0, -1)} name "${p}"`,
          details: { where, role, name: p },
        },
      );
    }
    seen.add(p);
  }
}

/**
 * The primitive atomic builder. See §3.1.
 *
 * @param {(ctx: object, local: object, runInfo: object) => string | Promise<string>} fn
 * @param {{ inputs?: string[], outputs: string[] }} options
 * @returns {object} Rail-Node with `__rail_kind__: 'atom'`
 */
export function atom(fn, options) {
  if (typeof fn !== 'function') {
    throw new TypeError(`atom(fn, options): fn must be a function, got ${typeof fn}`);
  }
  if (!isPlainObject(options)) {
    throw new TypeError('atom(fn, options): options must be a plain object');
  }

  const where = 'atom()';
  const inputs = options.inputs === undefined
    ? ['in']
    : options.inputs.slice();
  validatePortList(inputs, 'inputs', where);

  const outputs = Array.isArray(options.outputs) ? options.outputs.slice() : options.outputs;
  validatePortList(outputs, 'outputs', where);

  const node = {
    __rail_type__: 'node',
    __rail_kind__: 'atom',
    inputs,
    outputs,
  };

  const outputsSet = new Set(outputs);

  async function doInvoke(entry, ctx, local, runState, path, traceEntry) {
    const runInfo = {
      signal: runState.combinedSignal,
      flowName: runState.flowName,
      traceEntry,
    };
    const result = await fn(ctx, local, runInfo);
    if (typeof result !== 'string' || !outputsSet.has(result)) {
      const positionLabel = path.length === 0
        ? '<top-level>'
        : path.join('.');
      throw new RailRuntimeError('UNKNOWN_OUTPUT_AT_RUNTIME', {
        flowName: runState.flowName,
        message: `node '${positionLabel}' returned ${JSON.stringify(result)}; expected one of: ${outputs.join(', ')}`,
        details: { path, returned: result, expected: outputs },
      });
    }
    return result;
  }

  node._invoke = (entry, ctx, local, runState, path) =>
    invokeNode(doInvoke, 'atom', entry, ctx, local, runState, path);

  return node;
}

/**
 * String-or-array convenience over `atom` with single-output
 * nullish-return support. See §3.2.
 *
 * @param {(ctx: object, local: object, runInfo: object) => string | null | undefined | Promise<string | null | undefined>} fn
 * @param {string | string[]} inputs
 * @param {string | string[]} outputs
 * @returns {object} Rail-Node with `__rail_kind__: 'atom'`
 */
export function nstep(fn, inputs, outputs) {
  if (typeof fn !== 'function') {
    throw new TypeError(`nstep(fn, ...): fn must be a function, got ${typeof fn}`);
  }
  const inputList = Array.isArray(inputs) ? inputs : [inputs];
  const outputList = Array.isArray(outputs) ? outputs : [outputs];

  const wrapped = async (ctx, local, runInfo) => {
    const ret = await fn(ctx, local, runInfo);
    if (ret == null && outputList.length === 1) {
      return outputList[0];
    }
    return ret;
  };

  return atom(wrapped, { inputs: inputList, outputs: outputList });
}

/**
 * The convenience factory for the Railway success/failure pattern. See §3.3.
 *
 * @param {(ctx: object, local: object, runInfo: object) => void | Promise<void>} fn
 * @returns {object} Rail-Node with `__rail_kind__: 'atom'`,
 *                   inputs `['success']`, outputs `['success', 'failure']`.
 */
export function step(fn) {
  if (typeof fn !== 'function') {
    throw new TypeError(`step(fn): fn must be a function, got ${typeof fn}`);
  }
  const inner = async (ctx, local, runInfo) => {
    await fn(ctx, local, runInfo);
    return 'success';
  };
  return nstep(catchTo(inner, 'failure'), 'success', ['success', 'failure']);
}

/**
 * Best-effort step on the success rail. See §3.4.
 *
 * @param {(ctx: object, local: object, runInfo: object) => void | Promise<void>} fn
 */
export function pass(fn) {
  if (typeof fn !== 'function') {
    throw new TypeError(`pass(fn): fn must be a function, got ${typeof fn}`);
  }
  const inner = async (ctx, local, runInfo) => {
    await fn(ctx, local, runInfo);
    return 'success';
  };
  return nstep(catchTo(inner, 'success'), 'success', 'success');
}

/**
 * Best-effort step on the failure rail. See §3.5.
 *
 * @param {(ctx: object, local: object, runInfo: object) => void | Promise<void>} fn
 */
export function fail(fn) {
  if (typeof fn !== 'function') {
    throw new TypeError(`fail(fn): fn must be a function, got ${typeof fn}`);
  }
  const inner = async (ctx, local, runInfo) => {
    await fn(ctx, local, runInfo);
    return 'failure';
  };
  return nstep(catchTo(inner, 'failure'), 'failure', 'failure');
}
