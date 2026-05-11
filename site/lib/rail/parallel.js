/**
 * `parallel(branches)` — Parallel-Node factory. See spec §3.7, §6.2, §11.
 *
 * Runs all branches concurrently via `Promise.allSettled`. Returns a
 * typed `parallel-results` ctx carrying each branch's terminal
 * `{ terminus, ctx }`. On any branch failure, awaits all siblings,
 * then re-throws the first error in branch declaration order.
 *
 * Branches each receive their own fork of the run-state so that
 * interleaved `await`s do not trample per-fork slots like `depth`
 * and `currentInput`. An internal AbortController is folded into
 * each branch's combined signal so a sibling failure causes
 * cooperative abort of in-flight work.
 *
 * Implementation: each Parallel-Node is `Object.create(PARALLEL_PROTO)`
 * with per-instance state (`branches`, `_branchKeys`, `_compiled`).
 * The methods on PARALLEL_PROTO are shared across all Parallel-Nodes
 * — they dispatch to module-level helpers via `this`.
 */

import {
  RailCompileError,
  RailRuntimeError,
} from './errors.js';
import { isRailNode } from './ctx.js';
import {
  callLogger,
  checkKillAndLimit,
  combineSignals,
  emitTracer,
  now,
  round2,
} from './runtime.js';

/* ------------------------------------------------------------------ */
/* Module-level operations on a Parallel-Node                         */
/* ------------------------------------------------------------------ */

function compileParallel(node) {
  if (node._compiled) return;

  const errors = [];
  for (const key of node._branchKeys) {
    const b = node.branches[key];
    if (!isRailNode(b)) {
      errors.push({ code: 'NOT_A_NODE', path: key });
      continue;
    }
    try {
      if (!b.compiled()) b.compile();
    } catch (e) {
      if (e instanceof RailCompileError) {
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
    throw new RailCompileError('declaration', errors);
  }
  node._compiled = true;
}

/**
 * Runs a single branch. Returns either { status: 'ok', key, result }
 * or { status: 'failed', key, error } — never throws.
 */
function runBranch(node, branchKey, ctx, runState, internalAC) {
  const branch = node.branches[branchKey];
  const compoundName = `${runState._parallelName}.${branchKey}`;
  const branchInputPort = branch.inputs?.[0] ?? 'in';
  const shared = runState.shared;

  const branchCombined = combineSignals([
    runState.combinedSignal,
    internalAC.signal,
  ]);

  /** @type {any} */
  const branchFork = {
    ...runState,
    currentInput: branchInputPort,
    combinedSignal: branchCombined,
  };
  // Activity branches increment depth, per §3.7 ("if a parallel branch
  // is an Activity, that Activity's invocation increments depth as
  // any sub-activity would").
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
      emitBranchThrow(shared, runState.depth, branchKey, e, round2(t1 - t0));
      pushTraceEntry(shared, compoundName, runState.depth, round2(t1 - t0), null, true, e);
      return { status: 'failed', key: branchKey, error: e };
    }

    emitTracer(shared, {
      type: 'branch-start',
      ts: round2(t0 - shared.runStartTime),
      depth: runState.depth,
      branch: branchKey,
    });

    let result;
    let invokeError;
    try {
      result = await branch.invoke(compoundName, ctx, branchFork);
    } catch (e) {
      invokeError = e;
    }

    const t1 = now();
    const duration = round2(t1 - t0);

    if (invokeError !== undefined) {
      let propagated = invokeError;
      if (
        !(invokeError instanceof RailRuntimeError) &&
        !(invokeError instanceof RailCompileError)
      ) {
        propagated = new RailRuntimeError(
          'UNHANDLED_THROW',
          `Branch "${compoundName}" threw: ${invokeError?.message ?? invokeError}`,
          {
            flow: shared.flowName,
            trace: shared.trace,
            ctx,
            cause: invokeError,
          }
        );
      }
      try { internalAC.abort(propagated); } catch { internalAC.abort(); }
      emitBranchThrow(shared, runState.depth, branchKey, propagated, duration);
      pushTraceEntry(shared, compoundName, runState.depth, duration, null, true, propagated);
      return { status: 'failed', key: branchKey, error: propagated };
    }

    // Validate invoke contract shape.
    if (
      typeof result !== 'object' ||
      result === null ||
      typeof result.output !== 'string'
    ) {
      const err = new RailRuntimeError(
        'INVALID_SUB_NODE',
        `Branch "${compoundName}" invoke returned invalid shape`,
        { flow: shared.flowName, trace: shared.trace, ctx }
      );
      try { internalAC.abort(err); } catch { internalAC.abort(); }
      emitBranchThrow(shared, runState.depth, branchKey, err, duration);
      pushTraceEntry(shared, compoundName, runState.depth, duration, null, true, err);
      return { status: 'failed', key: branchKey, error: err };
    }
    if (!branch.outputs.includes(result.output)) {
      const err = new RailRuntimeError(
        'UNKNOWN_OUTPUT_AT_RUNTIME',
        `Branch "${compoundName}" returned unknown output "${result.output}"; expected one of: ${branch.outputs.join(', ')}`,
        { flow: shared.flowName, trace: shared.trace, ctx }
      );
      try { internalAC.abort(err); } catch { internalAC.abort(); }
      emitBranchThrow(shared, runState.depth, branchKey, err, duration);
      pushTraceEntry(shared, compoundName, runState.depth, duration, null, true, err);
      return { status: 'failed', key: branchKey, error: err };
    }

    emitTracer(shared, {
      type: 'branch-end',
      ts: round2(t1 - shared.runStartTime),
      depth: runState.depth,
      branch: branchKey,
      output: result.output,
    });
    pushTraceEntry(shared, compoundName, runState.depth, duration, result.output, false);

    return { status: 'ok', key: branchKey, result };
  })();
}

function emitBranchThrow(shared, depth, branchKey, error, duration) {
  emitTracer(shared, {
    type: 'branch-throw',
    ts: round2(now() - shared.runStartTime),
    depth,
    branch: branchKey,
    error,
    duration,
  });
}

function pushTraceEntry(shared, step, depth, duration, output, threw, error) {
  const entry = { step, output, duration, depth, threw };
  if (error !== undefined) entry.error = error;
  shared.trace.push(entry);
  callLogger(shared, entry);
}

async function invokeParallel(node, name, ctx, runState) {
  if (!node._compiled) {
    throw new RailRuntimeError(
      'INTERNAL',
      `Parallel-Node "${name}" invoked before compile`,
      {
        flow: runState.shared.flowName,
        trace: runState.shared.trace,
        ctx,
      }
    );
  }

  const internalAC = new AbortController();
  // Stash the parallel-node's name in a per-call slot so runBranch can
  // build branch compound names without taking yet-another parameter.
  const namedRunState = { ...runState, _parallelName: name };

  const branchPromises = node._branchKeys.map((key) =>
    runBranch(node, key, ctx, namedRunState, internalAC)
  );

  const settled = await Promise.all(branchPromises);

  // First error in branch declaration order, per spec §3.7.
  for (const r of settled) {
    if (r.status === 'failed') {
      throw r.error;
    }
  }

  // All succeeded — build typed parallel-results ctx.
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
  compile()  { return compileParallel(this); },
  compiled() { return this._compiled; },
  invoke(name, ctx, runState) { return invokeParallel(this, name, ctx, runState); },
};

/* ------------------------------------------------------------------ */
/* Factory                                                            */
/* ------------------------------------------------------------------ */

/**
 * @param {Record<string, object>} branches
 * @returns {object} An uncompiled Parallel-Node.
 */
export function parallel(branches) {
  if (!branches || typeof branches !== 'object' || Array.isArray(branches)) {
    throw new TypeError(
      'parallel(branches): branches must be an object map of branch name to Rail-Node'
    );
  }
  const branchKeys = Object.keys(branches);
  if (branchKeys.length === 0) {
    throw new TypeError('parallel(branches): at least one branch is required');
  }

  const node = Object.create(PARALLEL_PROTO);
  node.branches    = branches;
  node._branchKeys = branchKeys;
  node._compiled   = false;
  return node;
}
