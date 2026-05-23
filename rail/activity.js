/**
 * `activity(builderFn)` — graph-based group node builder. See spec §5.
 *
 * Each Activity is a plain object exposing the Node interface
 * (§2) plus a `toMermaid` hook (§2.4, §15.8). The builder
 * collects entries, exits, sub-nodes, and wires; eagerly validates
 * each operation; then, after the closure returns, runs the
 * whole-graph walk (§5.6) before returning the assembled node.
 */

import {
  RailBuildError,
  RailRuntimeError,
  validateName,
} from './errors.js';
import { invokeNode } from './runtime.js';
import { isRailNode } from './util.js';
import { renderActivityMermaid } from './mermaid.js';

const ENTRY_NODE = '';

/**
 * Parses a wire reference `'name.port'` or `'.port'`.
 * Returns `{ nodeName, portName }`. Throws RailBuildError(UNRESOLVED_WIRE_REFERENCE)
 * on malformed input.
 *
 * @param {unknown} ref
 * @param {string} where
 * @param {string} role  'source' | 'target' for error message
 */
function parseRef(ref, where, role) {
  if (typeof ref !== 'string') {
    throw new RailBuildError('UNRESOLVED_WIRE_REFERENCE', {
      message: `${where}: ${role} must be a string, got ${typeof ref}`,
      details: { where, role, ref },
    });
  }
  const dot = ref.indexOf('.');
  if (dot < 0) {
    throw new RailBuildError('UNRESOLVED_WIRE_REFERENCE', {
      message: `${where}: ${role} "${ref}" is missing the required dot separator`,
      details: { where, role, ref },
    });
  }
  const nodeName = ref.slice(0, dot);
  const portName = ref.slice(dot + 1);
  if (portName.length === 0 || portName.includes('.')) {
    throw new RailBuildError('UNRESOLVED_WIRE_REFERENCE', {
      message: `${where}: ${role} "${ref}" has an invalid port component`,
      details: { where, role, ref },
    });
  }
  return { nodeName, portName, raw: ref };
}

function endpointKey(nodeName, portName) {
  return `${nodeName}.${portName}`;
}

/**
 * @param {(a: object) => void} builderFn
 * @returns {object} fully-validated Activity Rail-Node
 */
export function activity(builderFn) {
  if (typeof builderFn !== 'function') {
    throw new TypeError('activity(builderFn): builderFn must be a function');
  }

  const entries = []; // ordered list of entry names
  const entrySet = new Set();
  const exits = [];
  const exitSet = new Set();
  const subNodes = new Map(); // localName → node
  /** @type {Array<{ source: {nodeName,portName,raw}, target: {nodeName,portName,raw} }>} */
  const wires = [];
  const wiredSources = new Set(); // endpointKey of sources that already have a wire
  let sealed = false;

  function ensureNotSealed(where) {
    if (sealed) {
      throw new RailBuildError('SEALED', {
        message: `${where}: builder has been sealed; cannot mutate after activity(...) returned`,
        details: { where },
      });
    }
  }

  function addEntry(name) {
    validateName(name, 'a.entry(name)');
    if (entrySet.has(name)) {
      throw new RailBuildError('DUPLICATE_INPUT', {
        message: `a.entry: duplicate entry name "${name}"`,
        details: { name },
      });
    }
    entrySet.add(name);
    entries.push(name);
  }

  function addExit(name) {
    validateName(name, 'a.exit(name)');
    if (exitSet.has(name)) {
      throw new RailBuildError('DUPLICATE_OUTPUT', {
        message: `a.exit: duplicate exit name "${name}"`,
        details: { name },
      });
    }
    exitSet.add(name);
    exits.push(name);
  }

  function addNode(name, node) {
    validateName(name, 'a.addNode(name, node)');
    if (subNodes.has(name)) {
      throw new RailBuildError('DUPLICATE_NODE_NAME', {
        message: `a.addNode: duplicate sub-node name "${name}"`,
        details: { name },
      });
    }
    if (!isRailNode(node)) {
      throw new RailBuildError('NOT_A_NODE', {
        message: `a.addNode: value for "${name}" is not a Rail-Node`,
        details: { name },
      });
    }
    subNodes.set(name, node);
  }

  function resolveSource(ref) {
    if (ref.nodeName === ENTRY_NODE) {
      if (!entrySet.has(ref.portName)) {
        // Either: not declared at all, or declared as an exit only.
        if (exitSet.has(ref.portName)) {
          throw new RailBuildError('WIRE_DIRECTION_INVALID', {
            message: `a.wire: source ".${ref.portName}" refers to an exit; only entries can be used as sources`,
            details: { ref: ref.raw, side: 'source' },
          });
        }
        throw new RailBuildError('UNRESOLVED_WIRE_REFERENCE', {
          message: `a.wire: source "${ref.raw}" — no entry named "${ref.portName}"`,
          details: { ref: ref.raw, side: 'source' },
        });
      }
      return { kind: 'entry', port: ref.portName };
    }
    const sub = subNodes.get(ref.nodeName);
    if (!sub) {
      throw new RailBuildError('UNRESOLVED_WIRE_REFERENCE', {
        message: `a.wire: source "${ref.raw}" — no sub-node named "${ref.nodeName}"`,
        details: { ref: ref.raw, side: 'source' },
      });
    }
    if (!sub.outputs.includes(ref.portName)) {
      if (sub.inputs.includes(ref.portName)) {
        throw new RailBuildError('WIRE_DIRECTION_INVALID', {
          message: `a.wire: source "${ref.raw}" refers to an input of "${ref.nodeName}"; only outputs can be used as sources`,
          details: { ref: ref.raw, side: 'source' },
        });
      }
      throw new RailBuildError('UNRESOLVED_WIRE_REFERENCE', {
        message: `a.wire: source "${ref.raw}" — sub-node "${ref.nodeName}" has no output "${ref.portName}"`,
        details: { ref: ref.raw, side: 'source' },
      });
    }
    return { kind: 'subOutput', subName: ref.nodeName, port: ref.portName };
  }

  function resolveTarget(ref) {
    if (ref.nodeName === ENTRY_NODE) {
      if (!exitSet.has(ref.portName)) {
        if (entrySet.has(ref.portName)) {
          throw new RailBuildError('WIRE_DIRECTION_INVALID', {
            message: `a.wire: target ".${ref.portName}" refers to an entry; only exits can be used as targets`,
            details: { ref: ref.raw, side: 'target' },
          });
        }
        throw new RailBuildError('UNRESOLVED_WIRE_REFERENCE', {
          message: `a.wire: target "${ref.raw}" — no exit named "${ref.portName}"`,
          details: { ref: ref.raw, side: 'target' },
        });
      }
      return { kind: 'exit', port: ref.portName };
    }
    const sub = subNodes.get(ref.nodeName);
    if (!sub) {
      throw new RailBuildError('UNRESOLVED_WIRE_REFERENCE', {
        message: `a.wire: target "${ref.raw}" — no sub-node named "${ref.nodeName}"`,
        details: { ref: ref.raw, side: 'target' },
      });
    }
    if (!sub.inputs.includes(ref.portName)) {
      if (sub.outputs.includes(ref.portName)) {
        throw new RailBuildError('WIRE_DIRECTION_INVALID', {
          message: `a.wire: target "${ref.raw}" refers to an output of "${ref.nodeName}"; only inputs can be used as targets`,
          details: { ref: ref.raw, side: 'target' },
        });
      }
      throw new RailBuildError('UNRESOLVED_WIRE_REFERENCE', {
        message: `a.wire: target "${ref.raw}" — sub-node "${ref.nodeName}" has no input "${ref.portName}"`,
        details: { ref: ref.raw, side: 'target' },
      });
    }
    return { kind: 'subInput', subName: ref.nodeName, port: ref.portName };
  }

  function addWire(sourceStr, targetStr) {
    const sourceRef = parseRef(sourceStr, 'a.wire(source, target)', 'source');
    const targetRef = parseRef(targetStr, 'a.wire(source, target)', 'target');

    const source = resolveSource(sourceRef);
    const target = resolveTarget(targetRef);

    const sourceKey = source.kind === 'entry'
      ? endpointKey(ENTRY_NODE, source.port)
      : endpointKey(source.subName, source.port);

    if (wiredSources.has(sourceKey)) {
      throw new RailBuildError('MULTIPLE_OUTGOING_WIRES', {
        message: `a.wire: source "${sourceRef.raw}" already has an outgoing wire`,
        details: { source: sourceRef.raw },
      });
    }
    wiredSources.add(sourceKey);

    wires.push({ source: { ...source, raw: sourceRef.raw }, target: { ...target, raw: targetRef.raw } });
  }

  const builder = {
    entry(...names) {
      ensureNotSealed('a.entry');
      if (names.length === 0) {
        throw new RailBuildError('MISSING_INPUTS', {
          message: 'a.entry(...names): at least one name required',
        });
      }
      for (const n of names) addEntry(n);
    },

    exit(...names) {
      ensureNotSealed('a.exit');
      if (names.length === 0) {
        throw new RailBuildError('MISSING_OUTPUTS', {
          message: 'a.exit(...names): at least one name required',
        });
      }
      for (const n of names) addExit(n);
    },

    addNode(name, node) {
      ensureNotSealed('a.addNode');
      addNode(name, node);
    },

    wire(sourceStr, targetStr) {
      ensureNotSealed('a.wire');
      addWire(sourceStr, targetStr);
    },
  };

  const returned = builderFn(builder);
  if (returned !== undefined) {
    throw new RailBuildError('ASYNC_BUILDER', {
      message: 'activity(builderFn): builder must return undefined (synchronous). Did you pass an async function?',
    });
  }
  sealed = true;

  // ----- Whole-graph validation walk (§5.6) -----

  if (entries.length === 0) {
    throw new RailBuildError('MISSING_INPUTS', {
      message: 'activity: no entries declared (a.entry required)',
    });
  }
  if (exits.length === 0) {
    throw new RailBuildError('MISSING_OUTPUTS', {
      message: 'activity: no exits declared (a.exit required)',
    });
  }
  if (subNodes.size === 0) {
    throw new RailBuildError('MISSING_NODES', {
      message: 'activity: no sub-nodes added (a.addNode required)',
    });
  }

  // Index wires for fast lookup.
  /** @type {Map<string, {kind:string,subName?:string,port:string}>} */
  const outgoing = new Map(); // sourceKey → target
  /** @type {Map<string, Array<{kind:string,subName?:string,port:string}>>} */
  const incoming = new Map(); // targetKey → sources[]

  function targetKey(t) {
    return t.kind === 'exit'
      ? endpointKey(ENTRY_NODE, t.port)
      : endpointKey(t.subName, t.port);
  }
  function sourceKey(s) {
    return s.kind === 'entry'
      ? endpointKey(ENTRY_NODE, s.port)
      : endpointKey(s.subName, s.port);
  }

  for (const w of wires) {
    outgoing.set(sourceKey(w.source), w.target);
    const tk = targetKey(w.target);
    if (!incoming.has(tk)) incoming.set(tk, []);
    incoming.get(tk).push(w.source);
  }

  // Every entry must have exactly one outgoing wire.
  for (const entryName of entries) {
    if (!outgoing.has(endpointKey(ENTRY_NODE, entryName))) {
      throw new RailBuildError('UNUSED_PORT', {
        message: `activity: entry ".${entryName}" has no outgoing wire`,
        details: { kind: 'entry', port: entryName },
      });
    }
  }

  // Every exit must be the target of at least one wire.
  for (const exitName of exits) {
    if (!incoming.has(endpointKey(ENTRY_NODE, exitName))) {
      throw new RailBuildError('UNUSED_PORT', {
        message: `activity: exit ".${exitName}" has no incoming wire`,
        details: { kind: 'exit', port: exitName },
      });
    }
  }

  // Every sub-node output must have exactly one outgoing wire.
  for (const [name, sub] of subNodes) {
    for (const out of sub.outputs) {
      if (!outgoing.has(endpointKey(name, out))) {
        throw new RailBuildError('UNUSED_PORT', {
          message: `activity: output "${name}.${out}" has no outgoing wire`,
          details: { node: name, port: out },
        });
      }
    }
  }

  // Every sub-node must have at least one input wired.
  for (const [name, sub] of subNodes) {
    let anyWired = false;
    for (const inp of sub.inputs) {
      if (incoming.has(endpointKey(name, inp))) {
        anyWired = true;
        break;
      }
    }
    if (!anyWired) {
      throw new RailBuildError('UNREACHABLE_NODE', {
        message: `activity: sub-node "${name}" has no incoming wire on any input`,
        details: { node: name, inputs: sub.inputs },
      });
    }
  }

  // ----- Build the runtime view -----

  // Forward map keyed by sourceKey, value = { kind, subName?, port, raw? }.
  // We materialise immediately so walks at run time are pure lookups.
  const wireFromSource = outgoing;

  /** @param {string} entryName */
  function followFromEntry(entryName) {
    return wireFromSource.get(endpointKey(ENTRY_NODE, entryName));
  }
  function followFromOutput(subName, port) {
    return wireFromSource.get(endpointKey(subName, port));
  }

  async function doInvoke(entry, ctx, local, runState, path) {
    if (!entrySet.has(entry)) {
      throw new RailRuntimeError('INTERNAL', {
        flowName: runState.flowName,
        message: `activity invoked with unknown entry "${entry}"`,
        details: { invariant: 'unknown entry', entry, declared: entries },
      });
    }

    let currentTarget = followFromEntry(entry);
    if (!local.children) local.children = {};

    while (true) {
      if (!currentTarget) {
        throw new RailRuntimeError('INTERNAL', {
          flowName: runState.flowName,
          message: 'activity walk reached an unwired endpoint',
          details: { invariant: 'no outgoing wire' },
        });
      }
      if (currentTarget.kind === 'exit') {
        return currentTarget.port;
      }
      const subName = currentTarget.subName;
      const subPort = currentTarget.port;
      const subNode = subNodes.get(subName);
      if (!subNode) {
        throw new RailRuntimeError('INTERNAL', {
          flowName: runState.flowName,
          message: `activity references missing sub-node "${subName}"`,
          details: { invariant: 'missing sub-node', subName },
        });
      }
      if (!local.children[subName]) local.children[subName] = {};
      const subLocal = local.children[subName];
      const subPath = [...path, subName];

      const exit = await subNode._invoke(subPort, ctx, subLocal, runState, subPath);
      currentTarget = followFromOutput(subName, exit);
    }
  }

  const node = {
    __rail_type__: 'node',
    __rail_kind__: 'activity',
    inputs: entries.slice(),
    outputs: exits.slice(),
  };

  node._invoke = (entry, ctx, local, runState, path) =>
    invokeNode(doInvoke, 'activity', entry, ctx, local, runState, path);

  // Expose the structural data for renderers and introspection. Marked
  // with leading underscore: not user API (§1.5).
  node._entries = entries.slice();
  node._exits = exits.slice();
  /** @type {Array<{name: string, node: object}>} */
  node._subNodes = Array.from(subNodes, ([name, sub]) => ({ name, node: sub }));
  node._wires = wires.map((w) => ({ source: { ...w.source }, target: { ...w.target } }));

  node.toMermaid = (name, opts) => renderActivityMermaid(node, name, opts);

  return node;
}
