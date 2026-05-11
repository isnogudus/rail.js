/**
 * `activity(builderFn)` — Activity factory + builder + check + invoke.
 *
 * See spec §2 (Activity), §3.1, §3.3, §3.4, §3.5, §6.2, §7, §8.
 *
 * Activities are composed of named sub-nodes and wires connecting
 * named ports. The builder enforces structural rules eagerly
 * (RailBuildError raised at the call site). `check()` runs the
 * post-builder validation in two phases — completeness and
 * topology — and recursively checks sub-nodes. At runtime, the
 * activity's invoke walks the wire graph until an exit endpoint
 * is reached. Cycles are valid topology; the `NO_EXIT_PATH` check
 * catches structurally trapped regions.
 *
 * Implementation: each Activity is `Object.create(ACTIVITY_PROTO)`
 * with per-instance state. The methods on ACTIVITY_PROTO dispatch
 * to module-level helpers via `this`.
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
  runStep,
  joinPath,
} from './runtime.js';
import { renderActivityToMermaid } from './mermaid.js';

/* ------------------------------------------------------------------ */
/* Internal wire-key encoding                                         */
/* ------------------------------------------------------------------ */

const ENTRY_KEY = '__entry__';

/** @param {string} nodeName @param {string} port */
function portKey(nodeName, port) {
  return `node:${nodeName}.${port}`;
}

/* ------------------------------------------------------------------ */
/* Endpoint handles                                                   */
/* ------------------------------------------------------------------ */

function makeEntryHandle(builderRef, name) {
  return Object.freeze({ _kind: 'entry', _builder: builderRef, _name: name });
}

function makeExitHandle(builderRef, name) {
  return Object.freeze({ _kind: 'exit', _builder: builderRef, _name: name });
}

function makeNodeHandle(builderRef, name, nodeRef) {
  const handle = {
    _kind: 'node',
    _builder: builderRef,
    _name: name,
    _node: nodeRef,
    out(port) {
      if (typeof port !== 'string' || !nodeRef.outputs.includes(port)) {
        throw new RailBuildError(
          'UNKNOWN_PORT',
          `Node "${name}" has no output "${port}"; declared outputs: [${nodeRef.outputs.join(', ')}]`,
          { node: name, port, side: 'output' }
        );
      }
      return Object.freeze({
        _kind: 'node-output',
        _builder: builderRef,
        _nodeName: name,
        _node: nodeRef,
        _port: port,
      });
    },
    in(port) {
      if (typeof port !== 'string' || !nodeRef.inputs.includes(port)) {
        throw new RailBuildError(
          'UNKNOWN_PORT',
          `Node "${name}" has no input "${port}"; declared inputs: [${nodeRef.inputs.join(', ')}]`,
          { node: name, port, side: 'input' }
        );
      }
      return Object.freeze({
        _kind: 'node-input',
        _builder: builderRef,
        _nodeName: name,
        _node: nodeRef,
        _port: port,
      });
    },
  };
  return Object.freeze(handle);
}

/* ------------------------------------------------------------------ */
/* Check phases                                                       */
/* ------------------------------------------------------------------ */

/**
 * Recursively check sub-nodes. Returns inherited errors with path
 * prefix; the outer check raises them as completeness errors.
 */
function checkSubNodes(state) {
  const inherited = [];
  for (const sn of state.subNodes) {
    try {
      if (!sn.node.isChecked()) sn.node.check();
    } catch (e) {
      if (e instanceof RailCheckError) {
        for (const inner of e.errors) {
          const path = inner.path ? `${sn.name}.${inner.path}` : sn.name;
          inherited.push({ ...inner, path });
        }
      } else {
        throw e;
      }
    }
  }
  return inherited;
}

/** Phase 1 — completeness (§7.3). */
function collectCompleteness(state) {
  const issues = [];

  if (state.entries.length === 0) {
    issues.push({ code: 'NO_ENTRY' });
  }
  if (state.exits.length === 0) {
    issues.push({ code: 'NO_EXITS' });
  }

  if (state.entries.length > 0) {
    const entryWires = state.wires.filter((w) => w.sourceKey === ENTRY_KEY);
    if (entryWires.length === 0) {
      issues.push({ code: 'ENTRY_NOT_WIRED' });
    }
  }

  for (const sn of state.subNodes) {
    for (const out of sn.node.outputs) {
      const k = portKey(sn.name, out);
      const has = state.wiredOutputs.has(k);
      if (!has) {
        issues.push({ code: 'UNWIRED_OUTPUT', node: sn.name, output: out });
      }
    }
  }

  for (const e of state.exits) {
    const matches = state.wires.filter(
      (w) => w.targetDesc.kind === 'exit' && w.targetDesc.name === e.name
    );
    if (matches.length === 0) {
      issues.push({ code: 'EXIT_NOT_WIRED', exit: e.name });
    }
  }

  return issues;
}

/** Builds runtime lookup tables. */
function buildAdjacency(state) {
  const entryWires = state.wires.filter((w) => w.sourceKey === ENTRY_KEY);
  const wireFromEntry = entryWires.length > 0 ? entryWires[0].targetDesc : null;

  const wireFromOutput = new Map();
  for (const w of state.wires) {
    if (w.sourceKey !== ENTRY_KEY) {
      wireFromOutput.set(w.sourceKey, w.targetDesc);
    }
  }

  const subNodeMap = new Map();
  for (const sn of state.subNodes) subNodeMap.set(sn.name, sn.node);

  return { wireFromEntry, wireFromOutput, subNodeMap };
}

/** Phase 2 — topology (§7.4). Forward + reverse BFS; cycles are allowed. */
function collectTopology(state, adjacency) {
  const { wireFromEntry, wireFromOutput, subNodeMap } = adjacency;
  const issues = [];

  // Forward BFS from entry's wire target.
  const reachableNodes = new Set();
  const reachableExits = new Set();
  const queue = [];
  if (wireFromEntry) {
    if (wireFromEntry.kind === 'exit') {
      reachableExits.add(wireFromEntry.name);
    } else {
      reachableNodes.add(wireFromEntry.name);
      queue.push(wireFromEntry.name);
    }
  }
  while (queue.length > 0) {
    const n = queue.shift();
    const sub = subNodeMap.get(n);
    if (!sub) continue;
    for (const out of sub.outputs) {
      const next = wireFromOutput.get(portKey(n, out));
      if (!next) continue;
      if (next.kind === 'exit') {
        reachableExits.add(next.name);
      } else if (!reachableNodes.has(next.name)) {
        reachableNodes.add(next.name);
        queue.push(next.name);
      }
    }
  }

  for (const sn of state.subNodes) {
    if (!reachableNodes.has(sn.name)) {
      issues.push({ code: 'UNREACHABLE_NODE', node: sn.name });
    }
  }
  for (const e of state.exits) {
    if (!reachableExits.has(e.name)) {
      issues.push({ code: 'UNREACHABLE_EXIT', exit: e.name });
    }
  }

  // Reverse BFS from exits: every forward-reachable node must reach
  // at least one exit. Otherwise NO_EXIT_PATH.
  const reverseAdj = new Map();
  for (const sn of state.subNodes) reverseAdj.set(sn.name, []);
  for (const [srcKey, targetDesc] of wireFromOutput) {
    const m = srcKey.match(/^node:(.+?)\.(.+)$/);
    if (!m) continue;
    const srcNode = m[1];
    if (targetDesc.kind === 'node') {
      const list = reverseAdj.get(targetDesc.name);
      if (list) list.push(srcNode);
    }
  }

  const exitReachable = new Set();
  const rq = [];
  for (const e of state.exits) {
    for (const [srcKey, td] of wireFromOutput) {
      if (td.kind === 'exit' && td.name === e.name) {
        const m = srcKey.match(/^node:(.+?)\.(.+)$/);
        if (m) {
          const src = m[1];
          if (!exitReachable.has(src)) {
            exitReachable.add(src);
            rq.push(src);
          }
        }
      }
    }
  }
  while (rq.length > 0) {
    const n = rq.shift();
    const preds = reverseAdj.get(n) ?? [];
    for (const p of preds) {
      if (!exitReachable.has(p)) {
        exitReachable.add(p);
        rq.push(p);
      }
    }
  }

  for (const n of reachableNodes) {
    if (!exitReachable.has(n)) {
      issues.push({ code: 'NO_EXIT_PATH', node: n });
    }
  }

  return issues;
}

/* ------------------------------------------------------------------ */
/* Module-level operations on an Activity                             */
/* ------------------------------------------------------------------ */

function checkActivity(node) {
  if (node._checked) return;
  const state = node._state;

  const inherited = checkSubNodes(state);

  const completeness = [...inherited, ...collectCompleteness(state)];
  if (completeness.length > 0) {
    throw new RailCheckError('completeness', completeness);
  }

  const adjacency = buildAdjacency(state);
  const topology = collectTopology(state, adjacency);
  if (topology.length > 0) {
    throw new RailCheckError('topology', topology);
  }

  node._wireFromEntry = adjacency.wireFromEntry;
  node._wireFromOutput = adjacency.wireFromOutput;
  node._subNodeMap = adjacency.subNodeMap;
  node._checked = true;
}

async function invokeActivity(node, name, ctx, runState, _local) {
  if (!node._checked) {
    throw new RailRuntimeError(
      'INTERNAL',
      `Activity "${name}" invoked before check()`,
      {
        flow: runState.shared.flowName,
        trace: runState.shared.trace,
        ctx,
      }
    );
  }

  // The activity loop runs at runState.depth (which is the inner depth
  // for sub-activities, or 0 for top-level). outerDepth is the depth
  // the runner returns to after activity-leave/throw — that is, the
  // depth of the calling scope: runState.parentDepth when set (by
  // runStep on fork), or runState.depth (top-level, no fork).
  const innerDepth = runState.depth;
  const outerDepth = runState.parentDepth ?? runState.depth;
  const shared = runState.shared;
  const invocation = runState.invocation ?? 1;

  const t0 = now();
  emitTracer(shared, {
    type: 'activity-enter',
    ts: round2(t0 - shared.runStartTime),
    depth: innerDepth,
    name,
    invocation,
    local: _local ?? {},
  });

  let currentCtx = ctx;
  let currentTarget = node._wireFromEntry;
  // The activity invoke's own loop runs at runState.path (set by the
  // outer runStep when forking; '' for top-level). Inner sub-step
  // names are joined via joinPath.

  try {
    if (currentTarget.kind === 'node') {
      runState.currentInput = currentTarget.port;
    }

    while (true) {
      if (currentTarget.kind === 'exit') {
        const t1 = now();
        emitTracer(shared, {
          type: 'activity-leave',
          ts: round2(t1 - shared.runStartTime),
          depth: outerDepth,
          name,
          output: currentTarget.name,
          invocation,
          local: _local ?? {},
        });
        return { output: currentTarget.name, ctx: currentCtx };
      }

      const subName = currentTarget.name;
      const subPort = currentTarget.port;
      const subNode = node._subNodeMap.get(subName);
      runState.currentInput = subPort;

      const result = await runStep(subNode, subName, currentCtx, runState);

      if (Object.prototype.hasOwnProperty.call(result, 'ctx')) {
        currentCtx = result.ctx;
      }

      const next = node._wireFromOutput.get(portKey(subName, result.output));
      if (!next) {
        throw new RailRuntimeError(
          'INTERNAL',
          `No outgoing wire from ${subName}.${result.output}`,
          {
            flow: shared.flowName,
            trace: shared.trace,
            ctx: currentCtx,
          }
        );
      }
      currentTarget = next;
    }
  } catch (e) {
    const t1 = now();
    emitTracer(shared, {
      type: 'activity-throw',
      ts: round2(t1 - shared.runStartTime),
      depth: outerDepth,
      name,
      error: e,
      duration: round2(t1 - t0),
      invocation,
      local: _local ?? {},
    });
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* Shared prototype                                                   */
/* ------------------------------------------------------------------ */

const ACTIVITY_PROTO = {
  railKind: 'activity',
  check()     { return checkActivity(this); },
  isChecked() { return this._checked; },
  invoke(name, ctx, runState, local) {
    return invokeActivity(this, name, ctx, runState, local);
  },
  toMermaid(name, opts) { return renderActivityToMermaid(this, name, opts); },
};

/* ------------------------------------------------------------------ */
/* Builder + factory                                                  */
/* ------------------------------------------------------------------ */

/**
 * @param {(a: object) => void} builderFn
 * @returns {object} An unchecked Activity (Rail-Node).
 */
export function activity(builderFn) {
  if (typeof builderFn !== 'function') {
    throw new TypeError('activity(builderFn): builderFn must be a function');
  }

  const builderRef = Object.freeze({ __rail: 'activity-builder' });

  const state = {
    builderRef,
    entries: /** @type {{name: string}[]} */ ([]),
    exits:   /** @type {{name: string}[]} */ ([]),
    subNodes:/** @type {{name: string, node: any}[]} */ ([]),
    wires:   /** @type {Array<{sourceKey: string, targetDesc: object}>} */ ([]),
    wiredOutputs: /** @type {Set<string>} */ (new Set()),
    entryWired: false,
    nodeNames: /** @type {Set<string>} */ (new Set()),
    exitNames: /** @type {Set<string>} */ (new Set()),
  };

  const builder = {
    entry(name) {
      validateName(name, 'a.entry(name)');
      if (state.entries.length > 0) {
        throw new RailBuildError(
          'MULTIPLE_ENTRIES',
          `a.entry(): activity already has an entry "${state.entries[0].name}"; declaring a second entry "${name}" is not allowed`,
          { existing: state.entries[0].name, attempted: name }
        );
      }
      state.entries.push({ name });
      return makeEntryHandle(builderRef, name);
    },

    exit(name) {
      validateName(name, 'a.exit(name)');
      if (state.exitNames.has(name)) {
        throw new RailBuildError(
          'DUPLICATE_EXIT',
          `a.exit(): exit "${name}" was already declared`,
          { name }
        );
      }
      state.exitNames.add(name);
      state.exits.push({ name });
      return makeExitHandle(builderRef, name);
    },

    standardExits() {
      const success = builder.exit('success');
      const failure = builder.exit('failure');
      return { success, failure };
    },

    addNode(name, subNode) {
      validateName(name, 'a.addNode(name, node)');
      if (!isRailNode(subNode)) {
        throw new RailBuildError(
          'NOT_A_NODE',
          `a.addNode(): value passed for "${name}" is not a Rail-Node`,
          { name }
        );
      }
      if (state.nodeNames.has(name)) {
        throw new RailBuildError(
          'DUPLICATE_NODE',
          `a.addNode(): a node named "${name}" was already added`,
          { name }
        );
      }
      state.nodeNames.add(name);
      state.subNodes.push({ name, node: subNode });
      return makeNodeHandle(builderRef, name, subNode);
    },

    wire(source, target) {
      if (source?._builder !== builderRef || target?._builder !== builderRef) {
        throw new RailBuildError(
          'WIRE_FROM_OTHER_BUILDER',
          'a.wire(): handle was returned by a different activity builder'
        );
      }
      if (source._kind !== 'entry' && source._kind !== 'node-output') {
        throw new RailBuildError(
          'INVALID_WIRE_DIRECTION',
          `a.wire(): source must be an entry or node-output handle, got ${source._kind}`
        );
      }
      if (
        target._kind !== 'exit' &&
        target._kind !== 'node' &&
        target._kind !== 'node-input'
      ) {
        throw new RailBuildError(
          'INVALID_WIRE_DIRECTION',
          `a.wire(): target must be an exit, node, or node-input handle, got ${target._kind}`
        );
      }
      if (target._kind === 'node' && target._node.inputs.length > 1) {
        throw new RailBuildError(
          'AMBIGUOUS_NODE_INPUT',
          `a.wire(): target node "${target._name}" has ${target._node.inputs.length} inputs (${target._node.inputs.join(', ')}); use .in('port') to disambiguate`,
          { node: target._name }
        );
      }

      if (source._kind === 'entry') {
        if (state.entries.length === 0) {
          throw new RailBuildError(
            'NO_ENTRY',
            'a.wire(): no entry has been declared yet'
          );
        }
        if (state.entryWired) {
          throw new RailBuildError(
            'MULTIPLE_ENTRY_WIRES',
            'a.wire(): the activity entry already has an outgoing wire'
          );
        }
        state.entryWired = true;
      } else {
        const k = portKey(source._nodeName, source._port);
        if (state.wiredOutputs.has(k)) {
          throw new RailBuildError(
            'MULTIPLE_OUTGOING_WIRES',
            `a.wire(): output "${source._nodeName}.${source._port}" already has a wire`,
            { node: source._nodeName, output: source._port }
          );
        }
        state.wiredOutputs.add(k);
      }

      const sourceKey =
        source._kind === 'entry'
          ? ENTRY_KEY
          : portKey(source._nodeName, source._port);

      let targetDesc;
      if (target._kind === 'exit') {
        targetDesc = { kind: 'exit', name: target._name };
      } else if (target._kind === 'node') {
        targetDesc = { kind: 'node', name: target._name, port: target._node.inputs[0] };
      } else {
        targetDesc = { kind: 'node', name: target._nodeName, port: target._port };
      }

      state.wires.push({ sourceKey, targetDesc });
    },
  };

  builderFn(builder);

  // Compute Node-interface inputs/outputs from declared entries/exits.
  const seenExits = new Set();
  const outputs = [];
  for (const e of state.exits) {
    if (!seenExits.has(e.name)) {
      seenExits.add(e.name);
      outputs.push(e.name);
    }
  }
  const inputs = state.entries.length > 0 ? [state.entries[0].name] : ['in'];

  const activityNode = Object.create(ACTIVITY_PROTO);
  activityNode.inputs          = inputs;
  activityNode.outputs         = outputs;
  activityNode._state          = state;
  activityNode._checked        = false;
  activityNode._wireFromEntry  = null;
  activityNode._wireFromOutput = null;
  activityNode._subNodeMap     = null;
  return activityNode;
}
