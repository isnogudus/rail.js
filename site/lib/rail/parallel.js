/**
 * `parallel(branches)` — Parallel-Node factory. See spec §3.7, §6.2, §11.
 *
 * Runs all branches concurrently via `Promise.allSettled`. Returns a
 * typed `parallel-results` ctx carrying each branch's terminal
 * `{ terminus, ctx }`. On any branch failure, awaits all siblings,
 * then re-throws the first error in branch declaration order.
 *
 * Branches each receive their own fork of the run-state so that
 * interleaved `await`s do not trample per-fork slots like `depth`,
 * `currentInput`, and `path`. An internal AbortController is folded
 * into each branch's combined signal so a sibling failure causes
 * cooperative abort of in-flight work.
 *
 * Implementation: each Parallel-Node is `Object.create(PARALLEL_PROTO)`
 * with per-instance state (`branches`, `_branchKeys`, `_checked`).
 */

import {
  RailBuildError,
  RailCheckError,
  RailRuntimeError,
  validateName,
} from './errors.js';
import { isRailNode } from './ctx.js';
import {
  callLogger,
  checkKillAndLimit,
  combineSignals,
  emitTracer,
  joinPath,
  now,
  round2,
} from './runtime.js';

/* ------------------------------------------------------------------ */
/* Check                                                              */
/* ------------------------------------------------------------------ */

function checkParallel(node) {
  if (node._checked) return;

  const errors = [];
  if (node._branchKeys.length === 0) {
    errors.push({ code: 'EMPTY_PARALLEL' });
  }
  for (const key of node._branchKeys) {
    const b = node.branches[key];
    try {
      if (!b.isChecked()) b.check();
    } catch (e) {
      if (e instanceof RailCheckError) {
        for (const inner of e.errors) {
          const path = inner.path ? `${key}.${inner.path}` : key;
          errors.push({ ...inner, path });
        }
      } else {
        throw e;
      }
    }
  }

  if (errors.length > 0) {
    throw new RailCheckError('completeness', errors);
  }
  node._checked = true;
}

/* ------------------------------------------------------------------ */
/* Branch runner                                                      */
/* ------------------------------------------------------------------ */

/**
 * Runs a single branch. Returns either { status: 'ok', key, result }
 * or { status: 'failed', key, error } — never throws.
 */
function runBranch(node, branchKey, ctx, runState, internalAC) {
  const branch = node.branches[branchKey];
  const shared = runState.shared;
  const branchPath = joinPath(runState.path, branchKey);
  const branchInputPort = branch.inputs?.[0] ?? 'in';

  const invocation = (shared.cycleCounters.get(branchPath) ?? 0) + 1;
  shared.cycleCounters.set(branchPath, invocation);
  const local = shared.localState.get(branchPath) ?? {};

  const branchCombined = combineSignals([
    runState.combinedSignal,
    internalAC.signal,
  ]);

  /** @type {any} */
  const branchFork = {
    ...runState,
    currentInput: branchInputPort,
    path: branchPath,
    combinedSignal: branchCombined,
    invocation,
  };
  if (branch.railKind === 'activity') {
    branchFork.depth = runState.depth + 1;
    branchFork.parentDepth = runState.depth;
  }

  const t0 = now();

  return (async () => {
    try {
      checkKillAndLimit(runState, ctx);
    } catch (e) {
      try { internalAC.abort(e); } catch { internalAC.abort(); }
      const t1 = now();
      emitBranchThrow(shared, runState.depth, branchKey, e, round2(t1 - t0), invocation, local);
      pushTraceEntry(shared, branchPath, runState.depth, round2(t1 - t0), null, true, e, invocation, local);
      return { status: 'failed', key: branchKey, error: e };
    }

    emitTracer(shared, {
      type: 'branch-start',
      ts: round2(t0 - shared.runStartTime),
      depth: runState.depth,
      branch: branchKey,
      invocation,
      local,
    });

    let result;
    let invokeError;
    try {
      result = await branch.invoke(branchKey, ctx, branchFork, local);
    } catch (e) {
      invokeError = e;
    }

    const t1 = now();
    const duration = round2(t1 - t0);

    if (invokeError !== undefined) {
      let propagated = invokeError;
      if (
        !(invokeError instanceof RailRuntimeError) &&
        !(invokeError instanceof RailCheckError)
      ) {
        propagated = new RailRuntimeError(
          'UNHANDLED_THROW',
          `Branch "${branchPath}" threw: ${invokeError?.message ?? invokeError}`,
          {
            flow: shared.flowName,
            trace: shared.trace,
            ctx,
            cause: invokeError,
          }
        );
      }
      try { internalAC.abort(propagated); } catch { internalAC.abort(); }
      emitBranchThrow(shared, runState.depth, branchKey, propagated, duration, invocation, local);
      pushTraceEntry(shared, branchPath, runState.depth, duration, null, true, propagated, invocation, local);
      return { status: 'failed', key: branchKey, error: propagated };
    }

    if (
      typeof result !== 'object' ||
      result === null ||
      typeof result.output !== 'string'
    ) {
      const err = new RailRuntimeError(
        'INVALID_SUB_NODE',
        `Branch "${branchPath}" invoke returned invalid shape`,
        { flow: shared.flowName, trace: shared.trace, ctx }
      );
      try { internalAC.abort(err); } catch { internalAC.abort(); }
      emitBranchThrow(shared, runState.depth, branchKey, err, duration, invocation, local);
      pushTraceEntry(shared, branchPath, runState.depth, duration, null, true, err, invocation, local);
      return { status: 'failed', key: branchKey, error: err };
    }
    if (!branch.outputs.includes(result.output)) {
      const err = new RailRuntimeError(
        'UNKNOWN_OUTPUT_AT_RUNTIME',
        `Branch "${branchPath}" returned unknown output "${result.output}"; expected one of: ${branch.outputs.join(', ')}`,
        { flow: shared.flowName, trace: shared.trace, ctx }
      );
      try { internalAC.abort(err); } catch { internalAC.abort(); }
      emitBranchThrow(shared, runState.depth, branchKey, err, duration, invocation, local);
      pushTraceEntry(shared, branchPath, runState.depth, duration, null, true, err, invocation, local);
      return { status: 'failed', key: branchKey, error: err };
    }

    // Persist returned local (if any).
    const outgoingLocal = Object.prototype.hasOwnProperty.call(result, 'local')
      ? result.local
      : local;
    if (Object.prototype.hasOwnProperty.call(result, 'local')) {
      shared.localState.set(branchPath, result.local);
    }

    emitTracer(shared, {
      type: 'branch-end',
      ts: round2(t1 - shared.runStartTime),
      depth: runState.depth,
      branch: branchKey,
      output: result.output,
      invocation,
      local: outgoingLocal,
    });
    pushTraceEntry(shared, branchPath, runState.depth, duration, result.output, false, undefined, invocation, outgoingLocal);

    return { status: 'ok', key: branchKey, result };
  })();
}

function emitBranchThrow(shared, depth, branchKey, error, duration, invocation, local) {
  emitTracer(shared, {
    type: 'branch-throw',
    ts: round2(now() - shared.runStartTime),
    depth,
    branch: branchKey,
    error,
    duration,
    invocation,
    local,
  });
}

function pushTraceEntry(shared, step, depth, duration, output, threw, error, invocation, local) {
  const entry = { step, output, duration, depth, threw, invocation, local };
  if (error !== undefined) entry.error = error;
  shared.trace.push(entry);
  callLogger(shared, entry);
}

/* ------------------------------------------------------------------ */
/* Invoke                                                             */
/* ------------------------------------------------------------------ */

async function invokeParallel(node, name, ctx, runState, _local) {
  if (!node._checked) {
    throw new RailRuntimeError(
      'INTERNAL',
      `Parallel-Node "${name}" invoked before check()`,
      {
        flow: runState.shared.flowName,
        trace: runState.shared.trace,
        ctx,
      }
    );
  }

  const internalAC = new AbortController();

  const branchPromises = node._branchKeys.map((key) =>
    runBranch(node, key, ctx, runState, internalAC)
  );

  const settled = await Promise.all(branchPromises);

  // First error in branch declaration order, per spec §3.7.
  for (const r of settled) {
    if (r.status === 'failed') {
      throw r.error;
    }
  }

  const results = Object.create(null);
  for (const r of settled) {
    const branchCtx =
      r.result && Object.prototype.hasOwnProperty.call(r.result, 'ctx')
        ? r.result.ctx
        : ctx;
    results[r.key] = {
      terminus: r.result.output,
      ctx: branchCtx,
    };
  }

  return {
    output: 'done',
    ctx: {
      __type: 'parallel-results',
      inputCtx: ctx,
      results,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Shared prototype                                                   */
/* ------------------------------------------------------------------ */

const PARALLEL_PROTO = {
  railKind: 'parallel',
  inputs: ['in'],
  outputs: ['done'],
  check()    { return checkParallel(this); },
  isChecked() { return this._checked; },
  invoke(name, ctx, runState, local) {
    return invokeParallel(this, name, ctx, runState, local);
  },
};

/* ------------------------------------------------------------------ */
/* Factory                                                            */
/* ------------------------------------------------------------------ */

/**
 * @param {Record<string, object>} branches
 * @returns {object} An unchecked Parallel-Node.
 */
export function parallel(branches) {
  if (!branches || typeof branches !== 'object' || Array.isArray(branches)) {
    throw new TypeError(
      'parallel(branches): branches must be an object map of branch name to Rail-Node'
    );
  }

  const branchKeys = Object.keys(branches);

  // Per-name eager validation; empty-map structural check deferred to check().
  for (const key of branchKeys) {
    validateName(key, 'parallel(): branch key', { branch: key });
    if (!isRailNode(branches[key])) {
      throw new RailBuildError(
        'NOT_A_NODE',
        `parallel(): branch "${key}" is not a Rail-Node`,
        { branch: key }
      );
    }
  }

  const node = Object.create(PARALLEL_PROTO);
  node.branches    = branches;
  node._branchKeys = branchKeys;
  node._checked    = false;
  return node;
}
