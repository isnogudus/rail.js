/**
 * `parallel(branches, merge?)` — concurrent group node. See spec §8, §15.6.
 *
 * Properties of the resulting node:
 *   __rail_kind__: 'parallel'
 *   inputs:  ['in']
 *   outputs: merge ? merge.outputs : ['out']
 *   _branches: branches
 *   _merge:    merge | undefined
 */

import {
  RailAggregateError,
  RailBuildError,
  RailError,
  RailRuntimeError,
  validateName,
} from './errors.js';
import { invokeNode } from './runtime.js';
import { isPlainObject, isRailNode } from './util.js';
import { renderActivityMermaid } from './mermaid.js';

const RESERVED_MERGE_NAME = '__merge__';

/**
 * @param {Record<string, object>} branches
 * @param {object} [merge]  optional merge node
 * @returns {object} Rail-Node with `__rail_kind__: 'parallel'`
 */
export function parallel(branches, merge) {
  if (!isPlainObject(branches)) {
    throw new TypeError('parallel(branches, merge?): branches must be a plain object');
  }

  const branchNames = Object.keys(branches);
  if (branchNames.length === 0) {
    throw new RailBuildError('MISSING_NODES', {
      message: 'parallel: branches object is empty',
    });
  }

  for (const name of branchNames) {
    validateName(name, 'parallel(): branch key', { branch: name });
    if (name === RESERVED_MERGE_NAME) {
      throw new RailBuildError('INVALID_NAME', {
        message: `parallel: branch name "${RESERVED_MERGE_NAME}" is reserved`,
        details: { branch: name },
      });
    }
    const b = branches[name];
    if (!isRailNode(b)) {
      throw new RailBuildError('NOT_A_NODE', {
        message: `parallel: branch "${name}" is not a Rail-Node`,
        details: { branch: name },
      });
    }
    if (b.inputs.length !== 1) {
      throw new RailBuildError('MULTI_INPUT_NODE', {
        message: `parallel: branch "${name}" has ${b.inputs.length} inputs; expected exactly 1. Wrap with pin(node, 'entry').`,
        details: { branch: name, inputs: b.inputs },
      });
    }
  }

  if (merge !== undefined) {
    if (!isRailNode(merge)) {
      throw new RailBuildError('NOT_A_NODE', {
        message: 'parallel: merge is not a Rail-Node',
        details: { arg: 'merge' },
      });
    }
    if (merge.inputs.length !== 1) {
      throw new RailBuildError('MULTI_INPUT_NODE', {
        message: `parallel: merge node has ${merge.inputs.length} inputs; expected exactly 1. Wrap with pin(node, 'entry').`,
        details: { arg: 'merge', inputs: merge.inputs },
      });
    }
  }

  const outputs = merge ? merge.outputs.slice() : ['out'];

  const node = {
    __rail_type__: 'node',
    __rail_kind__: 'parallel',
    inputs: ['in'],
    outputs,
    _branches: branches,
    _merge: merge,
  };

  async function doInvoke(entry, ctx, local, runState, path) {
    if (!local.branches) local.branches = {};

    const branchCtxes = {};

    const promises = branchNames.map((branchName) => {
      const branchNode = branches[branchName];
      if (!local.branches[branchName]) local.branches[branchName] = {};
      const branchLocal = local.branches[branchName];
      const branchPath = [...path, branchName];
      const branchEntry = branchNode.inputs[0];

      const branchCtx = { ...ctx };
      branchCtxes[branchName] = branchCtx;

      const p = branchNode._invoke(branchEntry, branchCtx, branchLocal, runState, branchPath);
      return p.catch((err) => {
        try { runState.internalAbortController.abort(); } catch { /* ignore */ }
        throw err;
      });
    });

    const settled = await Promise.allSettled(promises);

    const branchErrors = {};
    for (let i = 0; i < settled.length; i++) {
      if (settled[i].status === 'rejected') {
        const reason = settled[i].reason;
        const wrapped = reason instanceof RailError
          ? reason
          : new RailRuntimeError('UNHANDLED_THROW', {
              cause: reason,
              flowName: runState.flowName,
              message: `parallel branch "${branchNames[i]}" threw a non-library value: ${reason?.message ?? String(reason)}`,
            });
        branchErrors[branchNames[i]] = wrapped;
      }
    }
    if (Object.keys(branchErrors).length > 0) {
      const agg = new RailAggregateError(branchErrors);
      agg.flowName = runState.flowName;
      throw agg;
    }

    // Aggregate: replace incoming ctx in place with { branchName: branchCtx }.
    for (const k of Object.keys(ctx)) delete ctx[k];
    for (const branchName of branchNames) {
      ctx[branchName] = branchCtxes[branchName];
    }

    if (!merge) return 'out';

    if (!local._merge) local._merge = {};
    const mergePath = [...path, RESERVED_MERGE_NAME];
    const mergeEntry = merge.inputs[0];
    return await merge._invoke(mergeEntry, ctx, local._merge, runState, mergePath);
  }

  node._invoke = (entry, ctx, local, runState, path) =>
    invokeNode(doInvoke, 'parallel', entry, ctx, local, runState, path);

  node.toMermaid = (name, opts) => {
    // Wrap in a top-level subgraph for stand-alone rendering.
    const direction = opts?.direction ?? 'LR';
    const lines = [`flowchart ${direction}`];
    if (name) lines.push(`  %% ${name}`);
    // Use the activity renderer pathway via a synthetic wrapper: just
    // render parallel body as a top-level subgraph.
    // Simpler: emit a single subgraph block.
    let counter = 0;
    const ids = (prefix = 'n') => `${prefix}${counter++}`;
    const wrapperId = ids();
    lines.push(`  subgraph ${wrapperId} ["parallel"]`);
    const branchIds = new Map();
    for (const bn of branchNames) {
      const id = ids();
      branchIds.set(bn, id);
      const b = branches[bn];
      if (b.__rail_kind__ === 'activity' || b.__rail_kind__ === 'parallel') {
        lines.push(`    subgraph ${id} ["${bn}"]`);
        lines.push(`      ${ids()}["${b.__rail_kind__}"]`);
        lines.push(`    end`);
      } else {
        lines.push(`    ${id}["${bn}"]`);
      }
    }
    if (merge) {
      const mid = ids();
      lines.push(`    ${mid}["__merge__"]`);
      for (const bid of branchIds.values()) {
        lines.push(`    ${bid} --> ${mid}`);
      }
    }
    lines.push(`  end`);
    return lines.join('\n');
  };

  return node;
}
