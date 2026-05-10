/**
 * Runtime layer: shared utilities, run-state allocation, kill/counter
 * checks, tracer/logger plumbing, and the generic step-invocation
 * wrapper used by both flow.run (top-level) and the activity
 * step-execution loop. See spec §6.
 */

import { RailCompileError, RailRuntimeError } from './errors.js';

/**
 * High-resolution time. `performance.now()` if available, else `Date.now()`.
 *
 * @returns {number}
 */
export function now() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/**
 * Round to two decimals.
 * @param {number} n
 * @returns {number}
 */
export function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Combines multiple AbortSignals into one that aborts as soon as any
 * input aborts. Returns `undefined` if no inputs are given.
 *
 * Manual implementation; equivalent to `AbortSignal.any([...])` but
 * works on any environment with AbortController.
 *
 * @param {Array<AbortSignal|undefined>} signals
 * @returns {AbortSignal|undefined}
 */
export function combineSignals(signals) {
  const filtered = signals.filter(Boolean);
  if (filtered.length === 0) return undefined;
  if (filtered.length === 1) return filtered[0];

  const ac = new AbortController();
  for (const s of filtered) {
    if (s.aborted) {
      try { ac.abort(s.reason); } catch { ac.abort(); }
      return ac.signal;
    }
  }
  const onAbort = (e) => {
    try { ac.abort(/** @type {any} */ (e)?.target?.reason); } catch { ac.abort(); }
    for (const s of filtered) s.removeEventListener('abort', onAbort);
  };
  for (const s of filtered) {
    s.addEventListener('abort', onAbort, { once: true });
  }
  return ac.signal;
}

/**
 * Default logger factory. Closes over the flow name and produces a
 * single console line per trace entry. See spec §6.6.
 *
 * @param {string} flowName
 * @returns {(entry: object) => void}
 */
export function createDefaultLogger(flowName) {
  return function defaultLogger(entry) {
    const tag = entry.threw ? 'XX' : 'OK';
    const indent = '  '.repeat(entry.depth);
    const stepCol = (indent + entry.step).padEnd(20);
    const ms = entry.duration.toFixed(2) + 'ms';
    const tail = entry.threw
      ? ` -> (lib error: ${entry.error?.code ?? entry.error?.name ?? 'UNKNOWN'})`
      : ` -> ${entry.output}`;
    console.log(`[rail:${flowName}] ${tag}   ${stepCol} (${ms})${tail}`);
  };
}

/** No-op tracer. Used when `opts.tracer` is not provided. */
export function noopTracer() {}

/**
 * Allocates a fresh run-state from `opts` and a flow name. See spec §6.1.
 *
 * @param {object} opts
 * @param {string} flowName
 * @returns {object}
 */
export function createRunState(opts, flowName) {
  const userSignal = opts?.signal;
  const killSignal = opts?.killSignal;
  let combined;
  if (killSignal && userSignal) {
    combined = combineSignals([userSignal, killSignal]);
  } else if (killSignal) {
    combined = killSignal;
  } else if (userSignal) {
    combined = userSignal;
  }

  return {
    depth: 0,
    currentInput: 'in',
    combinedSignal: combined,
    shared: {
      stepCounter: 0,
      maxSteps: opts?.maxSteps ?? 1000,
      killSignal,
      logger: opts?.logger ?? createDefaultLogger(flowName),
      tracer: opts?.tracer ?? noopTracer,
      flowName,
      trace: [],
      runStartTime: 0,
    },
  };
}

/**
 * Calls the configured tracer with `event`. Wraps any throw as
 * `RailRuntimeError(TRACER_FAILED)`.
 *
 * @param {object} shared
 * @param {object} event
 */
export function emitTracer(shared, event) {
  try {
    shared.tracer(event);
  } catch (e) {
    throw new RailRuntimeError(
      'TRACER_FAILED',
      `Tracer threw: ${/** @type {any} */ (e)?.message ?? e}`,
      {
        flow: shared.flowName,
        trace: shared.trace,
        ctx: {},
        cause: /** @type {any} */ (e),
      }
    );
  }
}

/**
 * Calls the configured logger with a TraceEntry. Wraps any throw as
 * `RailRuntimeError(LOGGER_FAILED)`.
 *
 * @param {object} shared
 * @param {object} entry
 */
export function callLogger(shared, entry) {
  try {
    shared.logger(entry);
  } catch (e) {
    throw new RailRuntimeError(
      'LOGGER_FAILED',
      `Logger threw: ${/** @type {any} */ (e)?.message ?? e}`,
      {
        flow: shared.flowName,
        trace: shared.trace,
        ctx: {},
        cause: /** @type {any} */ (e),
      }
    );
  }
}

/**
 * Pre-execution checks (§6.2 steps 3 & 4).
 *
 * Throws `RailRuntimeError(KILLED)` if the kill switch is set and aborted.
 * Throws `RailRuntimeError(STEP_LIMIT_EXCEEDED)` if `++stepCounter` would exceed maxSteps.
 * Otherwise increments the counter.
 *
 * @param {object} runState
 * @param {object} ctx
 */
export function checkKillAndLimit(runState, ctx) {
  const shared = runState.shared;
  if (shared.killSignal?.aborted) {
    throw new RailRuntimeError('KILLED', 'Run aborted by killSignal', {
      flow: shared.flowName,
      trace: shared.trace,
      ctx,
    });
  }
  if (shared.stepCounter + 1 > shared.maxSteps) {
    throw new RailRuntimeError(
      'STEP_LIMIT_EXCEEDED',
      `Step limit ${shared.maxSteps} exceeded`,
      {
        flow: shared.flowName,
        trace: shared.trace,
        ctx,
      }
    );
  }
  shared.stepCounter++;
}

/** True iff value is a RailRuntimeError or RailCompileError instance. */
function isLibError(e) {
  return e instanceof RailRuntimeError || e instanceof RailCompileError;
}

/**
 * Generic step-invocation wrapper. Used by:
 *   - flow.run for the top-level node (recordToTrace=false, forkActivity=false)
 *   - Activity's step-execution loop for each visited sub-node (recordToTrace=true, forkActivity=true)
 *
 * Steps:
 *   1. Kill + counter check (§6.2 steps 3, 4).
 *   2. Emit `step-start` tracer event.
 *   3. Call `node.invoke(name, ctx, invokeRunState)`. If `forkActivity` is true and the node is
 *      an Activity, the runState is forked with `depth + 1` and `parentDepth = depth` before
 *      passing to invoke — implements the per-fork run-state semantics from §6.1.
 *   4. On throw: classify and re-throw or wrap; emit `step-throw`; optionally append entry + log.
 *   5. On return: validate invoke contract shape and declared output.
 *   6. Emit `step-end`; optionally append entry + log.
 *
 * @param {object} node          The Rail-Node to invoke.
 * @param {string} name          The compound name to use in events / trace.
 * @param {object} ctx           The running ctx entering the node.
 * @param {object} runState      The current run-state.
 * @param {{recordToTrace?: boolean, forkActivity?: boolean}} [opts]
 * @returns {Promise<{output: string, ctx?: object}>}
 */
export async function runStep(node, name, ctx, runState, opts = {}) {
  const recordToTrace = opts.recordToTrace ?? true;
  const forkActivity = opts.forkActivity ?? true;
  const shared = runState.shared;

  checkKillAndLimit(runState, ctx);

  const t0 = now();

  emitTracer(shared, {
    type: 'step-start',
    ts: round2(t0 - shared.runStartTime),
    depth: runState.depth,
    step: name,
    input: runState.currentInput,
    kind: node.railKind,
  });

  // Fork the run-state if invoking an Activity as a sub-call (§6.1, §8.2).
  let invokeRunState = runState;
  if (forkActivity && node.railKind === 'activity') {
    invokeRunState = {
      ...runState,
      depth: runState.depth + 1,
      parentDepth: runState.depth,
    };
  }

  let result;
  let invokeError;
  try {
    result = await node.invoke(name, ctx, invokeRunState);
  } catch (e) {
    invokeError = e;
  }

  const t1 = now();
  const duration = round2(t1 - t0);

  if (invokeError !== undefined) {
    let propagated = invokeError;
    if (!isLibError(invokeError)) {
      propagated = new RailRuntimeError(
        'UNHANDLED_THROW',
        `Step "${name}" threw: ${/** @type {any} */ (invokeError)?.message ?? invokeError}`,
        {
          flow: shared.flowName,
          trace: shared.trace,
          ctx,
          cause: /** @type {any} */ (invokeError),
        }
      );
    }
    const eventError = node.railKind === 'step' ? invokeError : propagated;
    emitTracer(shared, {
      type: 'step-throw',
      ts: round2(t1 - shared.runStartTime),
      depth: runState.depth,
      step: name,
      error: eventError,
      duration,
      kind: node.railKind,
    });
    if (recordToTrace) {
      const entry = {
        step: name,
        output: null,
        duration,
        depth: runState.depth,
        threw: true,
        error: eventError,
      };
      shared.trace.push(entry);
      callLogger(shared, entry);
    }
    throw propagated;
  }

  // Validate invoke contract shape.
  if (typeof result !== 'object' || result === null || typeof result.output !== 'string') {
    const err = new RailRuntimeError(
      'INVALID_SUB_NODE',
      `Node "${name}" invoke returned invalid shape (expected { output, ctx? })`,
      { flow: shared.flowName, trace: shared.trace, ctx }
    );
    emitTracer(shared, {
      type: 'step-throw',
      ts: round2(t1 - shared.runStartTime),
      depth: runState.depth,
      step: name,
      error: err,
      duration,
      kind: node.railKind,
    });
    if (recordToTrace) {
      const entry = {
        step: name,
        output: null,
        duration,
        depth: runState.depth,
        threw: true,
        error: err,
      };
      shared.trace.push(entry);
      callLogger(shared, entry);
    }
    throw err;
  }

  // Validate output is in declared outputs.
  if (!node.outputs.includes(result.output)) {
    const err = new RailRuntimeError(
      'UNKNOWN_OUTPUT_AT_RUNTIME',
      `Node "${name}" returned unknown output "${result.output}"; expected one of: ${node.outputs.join(', ')}`,
      { flow: shared.flowName, trace: shared.trace, ctx }
    );
    emitTracer(shared, {
      type: 'step-throw',
      ts: round2(t1 - shared.runStartTime),
      depth: runState.depth,
      step: name,
      error: err,
      duration,
      kind: node.railKind,
    });
    if (recordToTrace) {
      const entry = {
        step: name,
        output: null,
        duration,
        depth: runState.depth,
        threw: true,
        error: err,
      };
      shared.trace.push(entry);
      callLogger(shared, entry);
    }
    throw err;
  }

  emitTracer(shared, {
    type: 'step-end',
    ts: round2(t1 - shared.runStartTime),
    depth: runState.depth,
    step: name,
    output: result.output,
    duration,
    kind: node.railKind,
  });

  if (recordToTrace) {
    const entry = {
      step: name,
      output: result.output,
      duration,
      depth: runState.depth,
      threw: false,
    };
    shared.trace.push(entry);
    callLogger(shared, entry);
  }

  return result;
}
