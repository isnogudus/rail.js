/**
 * `flow(name, node)` — runtime wrapper. See spec §2 (Flow), §3.6, §6.
 *
 * A flow holds a top-level Rail-Node and a top-level name. The
 * factory returns a stateless object whose only responsibility is
 * to allocate a fresh run-state per invocation of `run(...)` and to
 * dispatch the top-level invoke. The flow does NOT pre-check the
 * node at factory time; the first `run(...)` triggers `node.check()`
 * if the node is unchecked.
 */

import {
  RailBuildError,
  RailCheckError,
  RailRuntimeError,
  validateName,
} from './errors.js';
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
  validateName(name, 'flow(name, node)');
  if (!isRailNode(node)) {
    throw new RailBuildError(
      'NOT_A_NODE',
      `flow(name, node): node must be a Rail-Node`,
      { name }
    );
  }

  const flowObject = {
    name,
    node,

    /**
     * Executes the held node with a fresh run-state.
     *
     * If the held node is not yet checked, calls `node.check()` first.
     * A `RailCheckError` from that call propagates out of `run(...)`
     * before any step executes.
     *
     * @param {object} [initialCtx]
     * @param {object} [opts]
     * @returns {Promise<{ctx: object, trace: object[], terminus: string}>}
     */
    async run(initialCtx = {}, opts = {}) {
      if (!node.isChecked()) node.check();

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
          topLevel: true,
        });
      } catch (e) {
        error = e;
      }

      if (error !== undefined) {
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
     * Renders the held node as Mermaid.
     */
    toMermaid(opts) {
      return renderNodeToMermaid(node, name, opts);
    },
  };

  return flowObject;
}
