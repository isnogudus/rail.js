/**
 * `activity(builderFn)` — Activity factory + builder + compile + invoke.
 *
 * See spec §2 (Activity), §3.1, §3.3, §3.4, §3.5, §6.2, §7, §8.
 *
 * Activities are composed of named sub-nodes and wires connecting
 * named ports. They are validated by a three-phase compile
 * (declaration / completeness / topology) that rejects malformed
 * topologies early. At runtime, the activity's invoke walks the
 * wire graph until an exit endpoint is reached.
 */

import { RailBuildError, RailCompileError, RailRuntimeError } from './errors.js';
import { isRailNode } from './ctx.js';
import {
  emitTracer,
  now,
  round2,
  runStep,
} from './runtime.js';
import { renderActivityToMermaid } from './mermaid.js';

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
/* Builder                                                            */
/* ------------------------------------------------------------------ */

/**
 * @param {(a: object) => void} builderFn
 * @returns {object} An uncompiled Activity (Rail-Node).
 */
export function activity(builderFn) {
  if (typeof builderFn !== 'function') {
    throw new TypeError('activity(builderFn): builderFn must be a function');
  }

  const builderRef = Object.freeze({ __rail: 'activity-builder' });

  const state = {
    builderRef,
    entries: /** @type {{name: string}[]} */ ([]),
    exits: /** @type {{name: string}[]} */ ([]),
    subNodes: /** @type {{name: string, node: any, valid: boolean}[]} */ ([]),
    wires: /** @type {Array<{sourceKey: string, targetDesc: object}>} */ ([]),
  };

  const builder = {
    entry(name) {
      if (typeof name !== 'string' || name.length === 0) {
        throw new TypeError('a.entry(name): name must be a non-empty string');
      }
      state.entries.push({ name });
      return makeEntryHandle(builderRef, name);
    },

    exit(name) {
      if (typeof name !== 'string' || name.length === 0) {
        throw new TypeError('a.exit(name): name must be a non-empty string');
      }
      state.exits.push({ name });
      return makeExitHandle(builderRef, name);
    },

    standardExits() {
      const success = builder.exit('success');
      const failure = builder.exit('failure');
      return { success, failure };
    },

    addNode(name, node) {
      if (typeof name !== 'string' || name.length === 0) {
        throw new TypeError('a.addNode(name, node): name must be a non-empty string');
      }
      if (!isRailNode(node)) {
        // Defer to phase A NOT_A_NODE so wiring continues (otherwise
        // the builder would crash before subsequent wire calls).
        state.subNodes.push({ name, node, valid: false });
        return makeNodeHandle(builderRef, name, { inputs: ['in'], outputs: [] });
      }
      state.subNodes.push({ name, node, valid: true });
      return makeNodeHandle(builderRef, name, node);
    },

    wire(source, target) {
      // 1. Cross-builder check.
      if (source?._builder !== builderRef || target?._builder !== builderRef) {
        throw new RailBuildError(
          'WIRE_FROM_OTHER_BUILDER',
          'a.wire(): handle was returned by a different activity builder'
        );
      }
      // 2. Direction.
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
      // 3. Ambiguous-input check for multi-input nodes.
      if (target._kind === 'node' && target._node.inputs.length > 1) {
        throw new RailBuildError(
          'AMBIGUOUS_NODE_INPUT',
          `a.wire(): target node "${target._name}" has ${target._node.inputs.length} inputs (${target._node.inputs.join(', ')}); use .in('port') to disambiguate`,
          { node: target._name }
        );
      }

      const sourceKey =
        source._kind === 'entry'
          ? '__entry__'
          : `node:${source._nodeName}.${source._port}`;

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

  /* ------------------------------------------------------------------ */
  /* Activity Node                                                      */
  /* ------------------------------------------------------------------ */

  // The Node-interface `outputs` is the set of declared exits.
  const seenExits = new Set();
  const outputs = [];
  for (const e of state.exits) {
    if (!seenExits.has(e.name)) {
      seenExits.add(e.name);
      outputs.push(e.name);
    }
  }
  const inputs = state.entries.length > 0 ? [state.entries[0].name] : ['in'];

  /** @type {any} */
  const activityNode = {
    railKind: 'activity',
    inputs,
    outputs,
    _state: state,
    _compiled: false,
    _wireFromEntry: null,
    _wireFromOutput: null,
    _subNodeMap: null,

    compile() {
      if (activityNode._compiled) return;

      // -- Pre-phase: recursive sub-compile, collecting wrapped errors --
      const inheritedErrors = [];
      for (const sn of state.subNodes) {
        if (!sn.valid) continue;
        try {
          if (!sn.node.compiled()) sn.node.compile();
        } catch (e) {
          if (e instanceof RailCompileError) {
            for (const inner of e.errors) {
              const path = inner.path ? `${sn.name}.${inner.path}` : sn.name;
              inheritedErrors.push({ ...inner, path });
            }
          } else {
            throw e;
          }
        }
      }

      // -- Phase A: declaration --
      const phaseA = [...inheritedErrors];

      if (state.entries.length === 0) {
        phaseA.push({ code: 'NO_ENTRY' });
      } else if (state.entries.length > 1) {
        phaseA.push({
          code: 'MULTIPLE_ENTRIES',
          names: state.entries.map((e) => e.name),
        });
      }

      if (state.exits.length === 0) {
        phaseA.push({ code: 'NO_EXITS' });
      }

      // Duplicate exits.
      const exitCount = Object.create(null);
      for (const e of state.exits) {
        exitCount[e.name] = (exitCount[e.name] ?? 0) + 1;
      }
      for (const n of Object.keys(exitCount)) {
        if (exitCount[n] > 1) phaseA.push({ code: 'DUPLICATE_EXIT', name: n });
      }

      // Duplicate sub-nodes.
      const nodeCount = Object.create(null);
      for (const sn of state.subNodes) {
        nodeCount[sn.name] = (nodeCount[sn.name] ?? 0) + 1;
      }
      for (const n of Object.keys(nodeCount)) {
        if (nodeCount[n] > 1) phaseA.push({ code: 'DUPLICATE_NODE', name: n });
      }

      // NOT_A_NODE for any deferred non-node addNode calls.
      for (const sn of state.subNodes) {
        if (!sn.valid) phaseA.push({ code: 'NOT_A_NODE', name: sn.name });
      }

      if (phaseA.length > 0) {
        throw new RailCompileError('declaration', phaseA);
      }

      // -- Phase B: completeness --
      const phaseB = [];

      const entryWires = state.wires.filter((w) => w.sourceKey === '__entry__');
      if (entryWires.length === 0) {
        phaseB.push({ code: 'ENTRY_NOT_WIRED' });
      } else if (entryWires.length > 1) {
        phaseB.push({ code: 'MULTIPLE_ENTRY_WIRES', count: entryWires.length });
      }

      // Each declared node-output must have exactly one outgoing wire.
      for (const sn of state.subNodes) {
        for (const out of sn.node.outputs) {
          const matches = state.wires.filter(
            (w) => w.sourceKey === `node:${sn.name}.${out}`
          );
          if (matches.length === 0) {
            phaseB.push({ code: 'UNWIRED_OUTPUT', node: sn.name, output: out });
          } else if (matches.length > 1) {
            phaseB.push({
              code: 'MULTIPLE_OUTGOING_WIRES',
              node: sn.name,
              output: out,
              count: matches.length,
            });
          }
        }
      }

      // Each exit must have at least one incoming wire.
      for (const e of state.exits) {
        const matches = state.wires.filter(
          (w) => w.targetDesc.kind === 'exit' && w.targetDesc.name === e.name
        );
        if (matches.length === 0) {
          phaseB.push({ code: 'EXIT_NOT_WIRED', exit: e.name });
        }
      }

      if (phaseB.length > 0) {
        throw new RailCompileError('completeness', phaseB);
      }

      // -- Pre-phase C: build runtime adjacency lookups --
      const wireFromEntry = entryWires[0].targetDesc;
      const wireFromOutput = new Map();
      for (const w of state.wires) {
        if (w.sourceKey !== '__entry__') {
          wireFromOutput.set(w.sourceKey, w.targetDesc);
        }
      }
      const subNodeMap = new Map();
      for (const sn of state.subNodes) subNodeMap.set(sn.name, sn.node);

      // -- Phase C: topology --
      const phaseC = [];

      // Reachability via BFS from entry's target.
      const reachableNodes = new Set();
      const reachableExits = new Set();
      const queue = [];
      if (wireFromEntry.kind === 'exit') {
        reachableExits.add(wireFromEntry.name);
      } else {
        reachableNodes.add(wireFromEntry.name);
        queue.push(wireFromEntry.name);
      }
      while (queue.length > 0) {
        const n = queue.shift();
        const sub = subNodeMap.get(n);
        for (const out of sub.outputs) {
          const next = wireFromOutput.get(`node:${n}.${out}`);
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
          phaseC.push({ code: 'UNREACHABLE_NODE', node: sn.name });
        }
      }
      for (const e of state.exits) {
        if (!reachableExits.has(e.name)) {
          phaseC.push({ code: 'UNREACHABLE_EXIT', exit: e.name });
        }
      }

      // Cycle detection (DFS with white/gray/black) on reachable subgraph.
      const color = Object.create(null);
      for (const n of reachableNodes) color[n] = 'white';
      let cyclePath = null;

      function dfs(start) {
        const stack = [{ node: start, idx: 0 }];
        color[start] = 'gray';
        const path = [start];
        while (stack.length > 0) {
          const frame = stack[stack.length - 1];
          const sub = subNodeMap.get(frame.node);
          if (frame.idx >= sub.outputs.length) {
            color[frame.node] = 'black';
            stack.pop();
            path.pop();
            continue;
          }
          const out = sub.outputs[frame.idx++];
          const next = wireFromOutput.get(`node:${frame.node}.${out}`);
          if (!next || next.kind === 'exit') continue;
          const m = next.name;
          if (color[m] === 'gray') {
            const idx = path.indexOf(m);
            cyclePath = path.slice(idx).concat(m);
            return;
          }
          if (color[m] === 'white') {
            color[m] = 'gray';
            path.push(m);
            stack.push({ node: m, idx: 0 });
          }
        }
      }

      for (const n of reachableNodes) {
        if (color[n] === 'white') {
          dfs(n);
          if (cyclePath) break;
        }
      }
      if (cyclePath) {
        phaseC.push({ code: 'CYCLE', path: cyclePath });
      }

      if (phaseC.length > 0) {
        throw new RailCompileError('topology', phaseC);
      }

      activityNode._wireFromEntry = wireFromEntry;
      activityNode._wireFromOutput = wireFromOutput;
      activityNode._subNodeMap = subNodeMap;
      activityNode._compiled = true;
    },

    compiled() {
      return activityNode._compiled;
    },

    async invoke(name, ctx, runState) {
      if (!activityNode._compiled) {
        throw new RailRuntimeError(
          'INTERNAL',
          `Activity "${name}" invoked before compile`,
          {
            flow: runState.shared.flowName,
            trace: runState.shared.trace,
            ctx,
          }
        );
      }

      // Per spec §6.1 + §6.8: this Activity's loop runs at runState.depth.
      // For a top-level activity (called by flow.run without forking),
      // runState.parentDepth is undefined and we treat it as equal to
      // depth — activity-leave then carries the same depth. For a
      // sub-activity (called by an outer's runStep with fork), runState
      // already has depth = outer + 1 and parentDepth = outer.
      const innerDepth = runState.depth;
      const outerDepth = runState.parentDepth ?? runState.depth;

      const t0 = now();
      emitTracer(runState.shared, {
        type: 'activity-enter',
        ts: round2(t0 - runState.shared.runStartTime),
        depth: innerDepth,
        name,
      });

      let currentCtx = ctx;
      let currentTarget = activityNode._wireFromEntry;

      try {
        // Set initial currentInput from the entry wire.
        if (currentTarget.kind === 'node') {
          runState.currentInput = currentTarget.port;
        }
        while (true) {
          if (currentTarget.kind === 'exit') {
            const t1 = now();
            emitTracer(runState.shared, {
              type: 'activity-leave',
              ts: round2(t1 - runState.shared.runStartTime),
              depth: outerDepth,
              name,
              output: currentTarget.name,
            });
            return { output: currentTarget.name, ctx: currentCtx };
          }

          const subName = currentTarget.name;
          const subPort = currentTarget.port;
          const subNode = activityNode._subNodeMap.get(subName);
          // Compound name: prefix with `name.` only when this Activity
          // is a sub-call (innerDepth > 0 OR the runState was forked).
          // Top-level Activity uses local sub-names directly.
          const compound =
            runState.parentDepth !== undefined
              ? `${name}.${subName}`
              : subName;

          runState.currentInput = subPort;

          const result = await runStep(subNode, compound, currentCtx, runState, {
            recordToTrace: true,
            forkActivity: true,
          });

          if (Object.prototype.hasOwnProperty.call(result, 'ctx')) {
            currentCtx = result.ctx;
          }

          const next = activityNode._wireFromOutput.get(
            `node:${subName}.${result.output}`
          );
          if (!next) {
            throw new RailRuntimeError(
              'INTERNAL',
              `No outgoing wire from ${subName}.${result.output}`,
              {
                flow: runState.shared.flowName,
                trace: runState.shared.trace,
                ctx: currentCtx,
              }
            );
          }
          currentTarget = next;
        }
      } catch (e) {
        const t1 = now();
        emitTracer(runState.shared, {
          type: 'activity-throw',
          ts: round2(t1 - runState.shared.runStartTime),
          depth: outerDepth,
          name,
          error: e,
          duration: round2(t1 - t0),
        });
        throw e;
      }
    },

    toMermaid(diagramName, opts) {
      return renderActivityToMermaid(activityNode, diagramName, opts);
    },
  };

  return activityNode;
}
