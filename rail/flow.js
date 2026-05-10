/**
 * `flow(name, node)` — runtime wrapper. See spec §2 (Flow), §3.6, §6.
 *
 * A flow holds a top-level Rail-Node and a top-level name. The
 * factory returns a plain stateless object whose only responsibility
 * is to allocate a fresh run-state per invocation of `run(...)`.
 */

import { RailBuildError, RailCompileError, RailRuntimeError } from './errors.js';
import { isRailNode } from './ctx.js';
import {
  emitTracer,
  now,
  round2,
  createRunState,
  runStep,
} from './runtime.js';
import { renderNodeToMermaid } from './mermaid.js';

/**
 * @param {string} name
 * @param {object} node
 * @returns {object} A flow object with `name`, `node`, `run`, and `toMermaid`.
 */
export function flow(name, node) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new RailBuildError(
      'INVALID_FLOW_NAME',
      `flow(name, node): name must be a non-empty string, got ${typeof name === 'string' ? '""' : typeof name}`
    );
  }
  if (!isRailNode(node)) {
    throw new RailBuildError(
      'NOT_A_NODE',
      `flow(name, node): node must be a Rail-Node`,
      { name }
    );
  }
  if (!node.compiled()) {
    throw new RailBuildError(
      'NODE_NOT_COMPILED',
      `flow(name, node): node must be compiled before use; call node.compile() first`,
      { name }
    );
  }

  const flowObject = {
    name,
    node,

    /**
     * Executes the held node with a fresh run-state.
     *
     * @param {object} [initialCtx]
     * @param {object} [opts]
     * @returns {Promise<{ctx: object, trace: object[], terminus: string}>}
     */
    async run(initialCtx = {}, opts = {}) {
      const runState = createRunState(opts, name);
      const shared = runState.shared;
      shared.runStartTime = now();
      runState.currentInput = node.inputs[0] ?? 'in';

      emitTracer(shared, {
        type: 'run-start',
        ts: 0,
        depth: 0,
        name,
        ctx: initialCtx,
      });

      let result;
      let error;
      try {
        result = await runStep(node, name, initialCtx, runState, {
          recordToTrace: node.railKind !== 'activity',
          forkActivity: false,
        });
      } catch (e) {
        error = e;
      }

      if (error !== undefined) {
        // runStep already classified non-lib errors into RailRuntimeError;
        // ensure trace + ctx are populated on lib errors that lacked them.
        if (error instanceof RailRuntimeError) {
          if (!error.flow) error.flow = name;
          if (!error.trace || error.trace.length === 0) error.trace = shared.trace;
          if (!error.ctx) error.ctx = initialCtx;
        }
        emitTracer(shared, {
          type: 'run-error',
          ts: round2(now() - shared.runStartTime),
          depth: 0,
          error,
        });
        throw error;
      }

      const finalCtx = Object.prototype.hasOwnProperty.call(result, 'ctx')
        ? result.ctx
        : initialCtx;
      emitTracer(shared, {
        type: 'run-end',
        ts: round2(now() - shared.runStartTime),
        depth: 0,
        terminus: result.output,
        ctx: finalCtx,
      });

      return {
        ctx: finalCtx,
        trace: shared.trace,
        terminus: result.output,
      };
    },

    /**
     * Renders the held node as Mermaid. Bound at module load time
     * (see `rail.js`).
     *
     * @param {object} [opts]
     * @returns {string}
     */
    toMermaid(opts) {
      return renderNodeToMermaid(node, name, opts);
    },
  };

  return flowObject;
}
