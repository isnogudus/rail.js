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
 */

import {
  RailBuildError,
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

  /** @type {any} */
  const parallelNode = {
    railKind: 'parallel',
    inputs: ['in'],
    outputs: ['done'],
    branches,
    _branchKeys: branchKeys,
    _compiled: false,

    compile() {
      if (parallelNode._compiled) return;

      const errors = [];
      for (const key of branchKeys) {
        const b = branches[key];
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
      parallelNode._compiled = true;
    },

    compiled() {
      return parallelNode._compiled;
    },

    async invoke(name, ctx, runState) {
      if (!parallelNode._compiled) {
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
      const shared = runState.shared;
      const internalAC = new AbortController();

      const branchPromises = branchKeys.map((key) => {
        const branch = branches[key];
        const compoundName = `${name}.${key}`;
        const branchInputPort = branch.inputs?.[0] ?? 'in';

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
        // Activity branches increment depth (sub-activity-style), per §3.7
        // ("if a parallel branch is an Activity, that Activity's
        //  invocation increments depth as any sub-activity would").
        if (branch.railKind === 'activity') {
          branchFork.depth = runState.depth + 1;
          branchFork.parentDepth = runState.depth;
        }

        const t0 = now();

        return (async () => {
          // Per-branch kill + counter check before the invocation.
          try {
            checkKillAndLimit(runState, ctx);
          } catch (e) {
            try { internalAC.abort(e); } catch { internalAC.abort(); }
            const t1 = now();
            const duration = round2(t1 - t0);
            emitTracer(shared, {
              type: 'branch-throw',
              ts: round2(t1 - shared.runStartTime),
              depth: runState.depth,
              branch: key,
              error: e,
              duration,
            });
            const entry = {
              step: compoundName,
              output: null,
              duration,
              depth: runState.depth,
              threw: true,
              error: e,
            };
            shared.trace.push(entry);
            callLogger(shared, entry);
            return { status: 'failed', key, error: e };
          }

          emitTracer(shared, {
            type: 'branch-start',
            ts: round2(t0 - shared.runStartTime),
            depth: runState.depth,
            branch: key,
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
            emitTracer(shared, {
              type: 'branch-throw',
              ts: round2(t1 - shared.runStartTime),
              depth: runState.depth,
              branch: key,
              error: propagated,
              duration,
            });
            const entry = {
              step: compoundName,
              output: null,
              duration,
              depth: runState.depth,
              threw: true,
              error: propagated,
            };
            shared.trace.push(entry);
            callLogger(shared, entry);
            return { status: 'failed', key, error: propagated };
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
            emitTracer(shared, {
              type: 'branch-throw',
              ts: round2(t1 - shared.runStartTime),
              depth: runState.depth,
              branch: key,
              error: err,
              duration,
            });
            const entry = {
              step: compoundName,
              output: null,
              duration,
              depth: runState.depth,
              threw: true,
              error: err,
            };
            shared.trace.push(entry);
            callLogger(shared, entry);
            return { status: 'failed', key, error: err };
          }
          if (!branch.outputs.includes(result.output)) {
            const err = new RailRuntimeError(
              'UNKNOWN_OUTPUT_AT_RUNTIME',
              `Branch "${compoundName}" returned unknown output "${result.output}"; expected one of: ${branch.outputs.join(', ')}`,
              { flow: shared.flowName, trace: shared.trace, ctx }
            );
            try { internalAC.abort(err); } catch { internalAC.abort(); }
            emitTracer(shared, {
              type: 'branch-throw',
              ts: round2(t1 - shared.runStartTime),
              depth: runState.depth,
              branch: key,
              error: err,
              duration,
            });
            const entry = {
              step: compoundName,
              output: null,
              duration,
              depth: runState.depth,
              threw: true,
              error: err,
            };
            shared.trace.push(entry);
            callLogger(shared, entry);
            return { status: 'failed', key, error: err };
          }

          emitTracer(shared, {
            type: 'branch-end',
            ts: round2(t1 - shared.runStartTime),
            depth: runState.depth,
            branch: key,
            output: result.output,
          });
          const entry = {
            step: compoundName,
            output: result.output,
            duration,
            depth: runState.depth,
            threw: false,
          };
          shared.trace.push(entry);
          callLogger(shared, entry);

          return { status: 'ok', key, result };
        })();
      });

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
    },
  };

  return parallelNode;
}
