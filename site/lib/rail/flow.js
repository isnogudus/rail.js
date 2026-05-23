/**
 * `flow(name, node)` — stateless run wrapper. See spec §9.
 *
 * Returns `{ name, node, run, toMermaid }`. Validates arguments
 * (INVALID_NAME / NOT_A_NODE / MULTI_INPUT_NODE) at construction time;
 * never re-walks the held node's internal graph. Built-in builders
 * return fully-validated nodes (§1.5).
 */

import {
  RailAggregateError,
  RailBuildError,
  RailError,
  RailRuntimeError,
  validateName,
} from './errors.js';
import { makeRunState } from './runtime.js';
import { isRailNode } from './util.js';
import { renderFlowMermaid } from './mermaid.js';

/**
 * @param {string} name
 * @param {object} node  Rail-Node with exactly one input
 */
export function flow(name, node) {
  validateName(name, 'flow(name, node)');
  if (!isRailNode(node)) {
    throw new RailBuildError('NOT_A_NODE', {
      message: 'flow(name, node): node is not a Rail-Node',
      details: { arg: 'node' },
    });
  }
  if (node.inputs.length !== 1) {
    throw new RailBuildError('MULTI_INPUT_NODE', {
      message: `flow(name, node): node has ${node.inputs.length} inputs; expected exactly 1. Wrap with pin(node, 'entry').`,
      details: { inputs: node.inputs },
    });
  }

  const flowObj = {
    name,
    node,
    async run(ctx, opts) {
      const initialCtx = ctx === undefined ? {} : ctx;
      const runState = makeRunState(name, opts);

      try {
        const entryName = node.inputs[0];
        const exit = await node._invoke(entryName, initialCtx, {}, runState, []);
        return { exit, ctx: initialCtx, trace: runState.trace };
      } catch (err) {
        if (err instanceof RailAggregateError) {
          if (err.flowName === undefined) err.flowName = name;
          throw err;
        }
        if (err instanceof RailError) {
          if (err.flowName === undefined) err.flowName = name;
          throw err;
        }
        throw new RailRuntimeError('UNHANDLED_THROW', {
          flowName: name,
          cause: err,
          message: `unhandled throw out of top-level node: ${err?.message ?? String(err)}`,
        });
      }
    },
    toMermaid(opts) {
      return renderFlowMermaid(flowObj, opts);
    },
  };

  return flowObj;
}
