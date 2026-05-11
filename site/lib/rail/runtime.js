/**
 * Runtime layer: shared utilities, run-state allocation, kill/counter
 * checks, tracer/logger plumbing, and the generic step-invocation
 * wrapper used by both `flow.run` (top-level) and the activity
 * step-execution loop. See spec §6.
 */

import { RailCheckError, RailRuntimeError } from './errors.js';

/* ------------------------------------------------------------------ */
/* Basics                                                             */
/* ------------------------------------------------------------------ */

/** High-resolution time. `performance.now()` if available, else `Date.now()`. */
export function now() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/** Round to two decimals. */
export function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Combines multiple AbortSignals into one that aborts as soon as any
 * input aborts. Returns `undefined` if no inputs are given.
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

/* ------------------------------------------------------------------ */
/* Logger + tracer defaults                                           */
/* ------------------------------------------------------------------ */

/**
 * Default logger factory. Closes over the flow name and produces a
 * single console line per trace entry. See spec §6.6.
 */
export function createDefaultLogger(flowName) {
  return function defaultLogger(entry) {
    const tag = entry.threw ? 'XX' : 'OK';
    const indent = '  '.repeat(entry.depth);
    const stepCol = (indent + entry.step).padEnd(20);
    const ms = entry.duration.toFixed(2) + 'ms';
    const suffix = entry.invocation && entry.invocation > 1 ? ` #${entry.invocation}` : '';
    const tail = entry.threw
      ? ` -> (lib error: ${entry.error?.code ?? entry.error?.name ?? 'UNKNOWN'})${suffix}`
      : ` -> ${entry.output}${suffix}`;
    console.log(`[rail:${flowName}] ${tag}   ${stepCol} (${ms})${tail}`);
  };
}

/** No-op tracer. Used when `opts.tracer` is not provided. */
export function noopTracer() {}

/* ------------------------------------------------------------------ */
/* Run-state allocation                                               */
/* ------------------------------------------------------------------ */

/**
 * Allocates a fresh run-state from `opts` and a flow name.
 * See spec §6.1.
 *
 * The run-state is two-layered:
 *   - Per-fork slots (`depth`, `currentInput`, `path`) are scalar and
 *     copied on `{ ...runState }`. Sub-activities and parallel
 *     branches receive a fork that shadows these.
 *   - The `shared` sub-object is held by reference; the same object
 *     across every fork in the run. It carries the step counter,
 *     signals, logger, tracer, flow name, `cycleCounters`,
 *     `localState`, and the trace buffer.
 *
 * @param {object} opts
 * @param {string} flowName
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
    path: '',
    // combinedSignal is per-fork: parallel branches override it with
    // their own (folding in the parallel-node's internal AbortController).
    combinedSignal: combined,
    shared: {
      stepCounter:    0,
      maxSteps:       opts?.maxSteps ?? 1000,
      killSignal,
      logger:         opts?.logger ?? createDefaultLogger(flowName),
      tracer:         opts?.tracer ?? noopTracer,
      flowName,
      cycleCounters:  new Map(),
      localState:     new Map(),
      trace:          [],
      runStartTime:   0,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Tracer / logger dispatch                                           */
/* ------------------------------------------------------------------ */

/**
 * Calls the configured tracer with `event`. Wraps any throw as
 * `RailRuntimeError(TRACER_FAILED)`.
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

/* ------------------------------------------------------------------ */
/* Pre-execution checks                                               */
/* ------------------------------------------------------------------ */

/**
 * Pre-execution checks (§6.2 steps 3 & 4).
 *
 * Throws `RailRuntimeError(KILLED)` if the kill switch is set and
 * aborted. Throws `RailRuntimeError(STEP_LIMIT_EXCEEDED)` if the
 * next step would exceed `maxSteps`. Otherwise increments the
 * counter.
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

/* ------------------------------------------------------------------ */
/* Path / invocation / local helpers                                  */
/* ------------------------------------------------------------------ */

/**
 * Computes the full dotted path for invoking a sub-node `name` from
 * scope at `parentPath`. See spec §6.1.
 */
export function joinPath(parentPath, name) {
  return parentPath === '' ? name : `${parentPath}.${name}`;
}

/* ------------------------------------------------------------------ */
/* Step invocation wrapper                                            */
/* ------------------------------------------------------------------ */

function isLibError(e) {
  return e instanceof RailRuntimeError || e instanceof RailCheckError;
}

/**
 * Generic step-invocation wrapper.
 *
 * Used by:
 *   - `flow.run` for the top-level node (no trace entry for activities;
 *     name is the flow's top-level name).
 *   - Activity's step-execution loop for each visited sub-node.
 *
 * Steps:
 *   1. Kill + step-counter check (§6.2 steps 3, 4).
 *   2. Compute fullPath, update cycleCounters, read local (§6.2 step 5).
 *   3. Emit `step-start` with `invocation` and `local`.
 *   4. Call `node.invoke(name, ctx, invokeRunState, local)`. For
 *      Activity and Parallel-Node, the run-state is forked with
 *      `path = fullPath` (and depth+1 for Activities) so that inner
 *      steps see the correct path prefix.
 *   5. On throw: classify and wrap; emit `step-throw`; append trace
 *      entry (if `recordToTrace`).
 *   6. On return: validate output is declared; store returned local
 *      under fullPath; emit `step-end`; append trace entry (if
 *      `recordToTrace`).
 *
 * @param {object} node          The Rail-Node to invoke.
 * @param {string} name          The node's local name (or top-level
 *                               name for `flow.run`).
 * @param {object} ctx           The running ctx entering the node.
 * @param {object} runState      The current run-state.
 * @param {{recordToTrace?: boolean, topLevel?: boolean}} [opts]
 * @returns {Promise<{output: string, ctx?: object, local?: object}>}
 */
export async function runStep(node, name, ctx, runState, opts = {}) {
  const topLevel = opts.topLevel ?? false;
  // Top-level Activity: the activity emits its own activity-enter/leave
  // and its inner sub-steps fill the trace; no compound entry.
  const recordToTrace =
    opts.recordToTrace ?? !(topLevel && node.railKind === 'activity');
  const shared = runState.shared;

  checkKillAndLimit(runState, ctx);

  // §6.2 step 5: full path, invocation, local.
  const fullPath = joinPath(runState.path, name);
  const invocation = (shared.cycleCounters.get(fullPath) ?? 0) + 1;
  shared.cycleCounters.set(fullPath, invocation);
  const local = shared.localState.get(fullPath) ?? {};

  const depth = runState.depth;
  const t0 = now();

  emitTracer(shared, {
    type: 'step-start',
    ts: round2(t0 - shared.runStartTime),
    depth,
    step: fullPath,
    input: runState.currentInput,
    invocation,
    local,
    kind: node.railKind,
  });

  // Fork run-state for composite kinds so inner paths/depths nest
  // correctly. Step-Nodes do not fork; the `fullPath` is passed via a
  // per-invocation slot so `runInfo.path` reflects this position.
  //
  // Top-level invocation (from flow.run): the held node IS the root
  // — its inner steps must not be prefixed by the flow name and must
  // not be one level deeper. So we skip the fork; `path` stays '' and
  // `depth` stays 0. For top-level Parallel-Nodes this means branches
  // get path = branchKey (not flowName.branchKey).
  let invokeRunState;
  if (node.railKind === 'activity' && !topLevel) {
    invokeRunState = {
      ...runState,
      depth: runState.depth + 1,
      parentDepth: runState.depth,
      path: fullPath,
    };
  } else if (node.railKind === 'parallel' && !topLevel) {
    invokeRunState = { ...runState, path: fullPath };
  } else {
    invokeRunState = { ...runState, fullPath };
  }
  invokeRunState.invocation = invocation;

  let result;
  let invokeError;
  try {
    result = await node.invoke(name, ctx, invokeRunState, local);
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
        `Step "${fullPath}" threw: ${/** @type {any} */ (invokeError)?.message ?? invokeError}`,
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
      depth,
      step: fullPath,
      error: eventError,
      duration,
      invocation,
      local,
      kind: node.railKind,
    });
    if (recordToTrace) {
      const entry = {
        step: fullPath,
        output: null,
        duration,
        depth,
        threw: true,
        invocation,
        local,
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
      `Node "${fullPath}" invoke returned invalid shape (expected { output, ctx?, local? })`,
      { flow: shared.flowName, trace: shared.trace, ctx }
    );
    emitTracer(shared, {
      type: 'step-throw',
      ts: round2(t1 - shared.runStartTime),
      depth,
      step: fullPath,
      error: err,
      duration,
      invocation,
      local,
      kind: node.railKind,
    });
    if (recordToTrace) {
      const entry = {
        step: fullPath,
        output: null,
        duration,
        depth,
        threw: true,
        invocation,
        local,
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
      `Node "${fullPath}" returned unknown output "${result.output}"; expected one of: ${node.outputs.join(', ')}`,
      { flow: shared.flowName, trace: shared.trace, ctx }
    );
    emitTracer(shared, {
      type: 'step-throw',
      ts: round2(t1 - shared.runStartTime),
      depth,
      step: fullPath,
      error: err,
      duration,
      invocation,
      local,
      kind: node.railKind,
    });
    if (recordToTrace) {
      const entry = {
        step: fullPath,
        output: null,
        duration,
        depth,
        threw: true,
        invocation,
        local,
        error: err,
      };
      shared.trace.push(entry);
      callLogger(shared, entry);
    }
    throw err;
  }

  // Persist local if the invoke returned one. Absent local → keep prior.
  const outgoingLocal = Object.prototype.hasOwnProperty.call(result, 'local')
    ? result.local
    : local;
  if (Object.prototype.hasOwnProperty.call(result, 'local')) {
    shared.localState.set(fullPath, result.local);
  }

  emitTracer(shared, {
    type: 'step-end',
    ts: round2(t1 - shared.runStartTime),
    depth,
    step: fullPath,
    output: result.output,
    duration,
    invocation,
    local: outgoingLocal,
    kind: node.railKind,
  });

  if (recordToTrace) {
    const entry = {
      step: fullPath,
      output: result.output,
      duration,
      depth,
      threw: false,
      invocation,
      local: outgoingLocal,
    };
    shared.trace.push(entry);
    callLogger(shared, entry);
  }

  return result;
}
