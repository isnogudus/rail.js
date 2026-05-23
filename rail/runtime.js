/**
 * Runtime core for rail.js v0.3.0. See spec §2.2, §13.
 *
 * Exports:
 *   invokeNode(doInvoke, kind, entry, ctx, local, runState, path) — the
 *     shared framing helper around any non-wrapper node body.
 *   makeRunState(flowName, opts) — constructs the per-run state.
 *   defaultConsoleLogger(entry, flowName) — the built-in console logger.
 *
 * `invokeNode` is exported as a public extension API (§2, §15.3) so
 * custom node kinds can opt into the standard framing.
 */

import { RailRuntimeError } from './errors.js';

export const DEFAULT_MAX_STEPS = 1000;
export const DEFAULT_TRACER_ERROR_POLICY = 'swallow';
export const DEFAULT_LOGGER_ERROR_POLICY = 'throw';

/**
 * Built-in console logger (§13.6). Writes one line per successfully
 * completed step to console.log. Indentation is `path.length * 2`
 * spaces; the label is `path.join('.')` with the flow name substituted
 * for the empty top-level path. When `cycle > 1`, the line is suffixed
 * with ` #N`.
 *
 * @param {object} entry  TraceEntry
 * @param {string} flowName
 */
export function defaultConsoleLogger(entry, flowName) {
  const indent = ' '.repeat(entry.path.length * 2);
  const label = entry.path.length === 0 ? flowName : entry.path.join('.');
  const duration = (entry.endTime - entry.startTime).toFixed(2);
  const cycleSuffix = entry.cycle > 1 ? ` #${entry.cycle}` : '';
  // eslint-disable-next-line no-console
  console.log(
    `[${flowName}] ${indent}${label} (${duration}ms) -> ${entry.exit}${cycleSuffix}`,
  );
}

function emitTrace(runState, entryRec, event) {
  if (!runState.tracer) return;
  try {
    runState.tracer(entryRec, event);
  } catch (err) {
    if (runState.tracerErrorPolicy === 'throw') throw err;
  }
}

function emitLog(runState, entryRec) {
  if (!runState.logger) return;
  try {
    runState.logger(entryRec);
  } catch (err) {
    if (runState.loggerErrorPolicy === 'throw') throw err;
  }
}

/**
 * The shared framing helper. See §2.2 for the authoritative listing.
 *
 * @param {(entry: string, ctx: object, local: object, runState: object,
 *           path: string[], traceEntry: object) => Promise<string>} doInvoke
 * @param {string} kind        the node's __rail_kind__
 * @param {string} entry       chosen input port
 * @param {object} ctx
 * @param {object} local
 * @param {object} runState
 * @param {string[]} path
 * @returns {Promise<string>}  the chosen exit name
 */
export async function invokeNode(doInvoke, kind, entry, ctx, local, runState, path) {
  local._cycles = (local._cycles ?? 0) + 1;

  const entryRec = {
    path,
    kind,
    cycle: local._cycles,
    entry,
    ctx: { ...ctx },
    local: { ...local },
    startTime: Date.now(),
  };

  runState.trace.push(entryRec);

  if (runState.trace.length > runState.maxSteps) {
    throw new RailRuntimeError('STEP_BUDGET_EXCEEDED', {
      flowName: runState.flowName,
      details: { maxSteps: runState.maxSteps },
    });
  }

  if (runState.killSignal?.aborted) {
    throw new RailRuntimeError('KILLED', { flowName: runState.flowName });
  }

  emitTrace(runState, entryRec, 'begin');

  const exit = await doInvoke(entry, ctx, local, runState, path, entryRec);

  entryRec.exit = exit;
  entryRec.endTime = Date.now();
  emitTrace(runState, entryRec, 'end');
  emitLog(runState, entryRec);

  return exit;
}

function combineSignals(signals) {
  const real = signals.filter((s) => s);
  if (real.length === 0) return new AbortController().signal;
  if (real.length === 1) return real[0];
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return AbortSignal.any(real);
  }
  const ctrl = new AbortController();
  for (const s of real) {
    if (s.aborted) {
      const reason = s.reason;
      if (reason !== undefined) ctrl.abort(reason);
      else ctrl.abort();
      break;
    }
    s.addEventListener(
      'abort',
      () => {
        if (ctrl.signal.aborted) return;
        const reason = s.reason;
        if (reason !== undefined) ctrl.abort(reason);
        else ctrl.abort();
      },
      { once: true },
    );
  }
  return ctrl.signal;
}

/**
 * Constructs the per-run state object (§13.1, §15.2).
 *
 * `AbortController` and `AbortSignal` are host-provided in embedded
 * engines (notably vanilla QuickJS). When they are unavailable, the
 * runState's signal fields fall back to `null` / `undefined` and the
 * library runs without cancellation support. `invokeNode`'s kill
 * check and `parallel`'s sibling-abort are already optional-chained
 * for this case.
 *
 * @param {string} flowName
 * @param {object} [opts]
 * @returns {object} runState
 */
export function makeRunState(flowName, opts) {
  const hasAC = typeof AbortController !== 'undefined';
  const internal = hasAC ? new AbortController() : null;
  const combined = hasAC
    ? combineSignals([opts?.signal, opts?.killSignal, internal.signal])
    : undefined;

  const logger = opts?.logger === undefined
    ? (entry) => defaultConsoleLogger(entry, flowName)
    : opts.logger;

  return {
    trace: [],
    maxSteps: opts?.maxSteps ?? DEFAULT_MAX_STEPS,
    flowName,
    tracer: opts?.tracer,
    logger,
    tracerErrorPolicy: opts?.tracerErrorPolicy ?? DEFAULT_TRACER_ERROR_POLICY,
    loggerErrorPolicy: opts?.loggerErrorPolicy ?? DEFAULT_LOGGER_ERROR_POLICY,
    killSignal: opts?.killSignal,
    combinedSignal: combined,
    internalAbortController: internal,
  };
}
