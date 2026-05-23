/**
 * `nrail(builderFn)` and `railway(builderFn)`. See spec §6, §7.
 *
 * `nrail` produces a standard Activity (`__rail_kind__: 'activity'`)
 * for pipelines with n outcome tracks. Steps consume named rails as
 * inputs and produce named rails as outputs; the builder tracks open
 * wires via a build-time Live-Set and emits the activity at build end.
 *
 * `railway` is a thin wrapper over `nrail` providing three convenience
 * methods (`r.step`, `r.pass`, `r.fail`) with automatic `catchTo`
 * wrapping for two-track success/failure pipelines.
 */

import {
  RailBuildError,
  validateName,
} from './errors.js';
import { atom, catchTo, nstep } from './atomic.js';
import { activity } from './activity.js';
import { isRailNode } from './util.js';

/**
 * @param {(r: object) => void} builderFn
 * @returns {object} fully-validated Activity Rail-Node
 */
export function nrail(builderFn) {
  if (typeof builderFn !== 'function') {
    throw new TypeError('nrail(builderFn): builderFn must be a function');
  }

  const entries = [];
  const entrySet = new Set();
  let entriesDeclared = false;

  // Sub-nodes are accumulated as { name, node } in declaration order.
  const subNodes = [];
  const subNodeNames = new Set();

  // Wires are accumulated as (sourceRef, targetRef) string pairs.
  const wires = [];

  // Live-Set: ordered list of { rail, source } entries.
  /** @type {Array<{ rail: string, source: string }>} */
  let liveSet = [];

  // Order-of-first-appearance for rail names — for exit ordering.
  const firstSeenRail = []; // ordered, unique
  const firstSeenRailSet = new Set();

  // Labels and pending links.
  /** @type {Map<string, { rail: string }>} */
  const labels = new Map();
  /** @type {Map<string, string[]>} */
  const pendingLinks = new Map();
  /** @type {Set<string>} */
  const labelHasIncomingWire = new Set();

  let sealed = false;

  function ensureNotSealed(where) {
    if (sealed) {
      throw new RailBuildError('SEALED', {
        message: `${where}: builder has been sealed; cannot mutate after nrail(...) returned`,
        details: { where },
      });
    }
  }

  function ensureEntriesDeclared(where) {
    if (!entriesDeclared) {
      throw new RailBuildError('ENTRIES_NOT_DECLARED', {
        message: `${where}: r.entry(...) must be called before any other builder method`,
        details: { where },
      });
    }
  }

  function noteRail(rail) {
    if (!firstSeenRailSet.has(rail)) {
      firstSeenRailSet.add(rail);
      firstSeenRail.push(rail);
    }
  }

  function consumeRail(rail, where) {
    const matches = [];
    const remaining = [];
    for (const item of liveSet) {
      if (item.rail === rail) matches.push(item);
      else remaining.push(item);
    }
    if (matches.length === 0) {
      const available = [...new Set(liveSet.map((i) => i.rail))];
      throw new RailBuildError('RAIL_NOT_LIVE', {
        message: `${where}: rail "${rail}" is not live. Available: [${available.join(', ')}]`,
        details: { rail, where, available },
      });
    }
    liveSet = remaining;
    return matches.map((m) => m.source);
  }

  function registerNode(name, node) {
    if (subNodeNames.has(name)) {
      throw new RailBuildError('DUPLICATE_NODE_NAME', {
        message: `nrail: duplicate node/label name "${name}"`,
        details: { name },
      });
    }
    subNodeNames.add(name);
    subNodes.push({ name, node });
  }

  const r = {
    entry(...names) {
      ensureNotSealed('r.entry');
      if (entriesDeclared) {
        throw new RailBuildError('ENTRIES_ALREADY_DECLARED', {
          message: 'r.entry: called more than once',
        });
      }
      if (names.length === 0) {
        throw new RailBuildError('MISSING_INPUTS', {
          message: 'r.entry(...names): at least one name required',
        });
      }
      for (const name of names) {
        validateName(name, 'r.entry');
        if (entrySet.has(name)) {
          throw new RailBuildError('DUPLICATE_NODE_NAME', {
            message: `r.entry: duplicate entry name "${name}"`,
            details: { name },
          });
        }
        entrySet.add(name);
        entries.push(name);
        noteRail(name);
        liveSet.push({ rail: name, source: `.${name}` });
      }
      entriesDeclared = true;
    },

    step(name, fn, inputs, outputs) {
      ensureNotSealed('r.step');
      ensureEntriesDeclared('r.step');
      validateName(name, 'r.step');
      if (typeof fn !== 'function') {
        throw new TypeError(`r.step(name, fn, ...): fn must be a function, got ${typeof fn}`);
      }
      const inputList = Array.isArray(inputs) ? inputs : [inputs];
      const outputList = Array.isArray(outputs) ? outputs : [outputs];

      if (inputList.length === 0) {
        throw new RailBuildError('MISSING_INPUTS', {
          message: `r.step("${name}"): inputs is empty`,
          details: { name },
        });
      }
      if (outputList.length === 0) {
        throw new RailBuildError('MISSING_OUTPUTS', {
          message: `r.step("${name}"): outputs is empty`,
          details: { name },
        });
      }

      // Consume input rails first so RAIL_NOT_LIVE fires before adding the node.
      const consumedPerRail = {};
      for (const rail of inputList) {
        consumedPerRail[rail] = consumeRail(rail, `r.step("${name}")`);
      }

      // Build the underlying nstep and register it.
      const node = nstep(fn, inputList, outputList);
      registerNode(name, node);

      // Create wires source → name.<rail> for each consumed entry.
      for (const rail of inputList) {
        for (const source of consumedPerRail[rail]) {
          wires.push({ source, target: `${name}.${rail}` });
        }
      }
      // Append produced rails to Live-Set.
      for (const rail of outputList) {
        noteRail(rail);
        liveSet.push({ rail, source: `${name}.${rail}` });
      }
    },

    addNode(name, node) {
      ensureNotSealed('r.addNode');
      ensureEntriesDeclared('r.addNode');
      validateName(name, 'r.addNode');
      if (!isRailNode(node)) {
        throw new RailBuildError('NOT_A_NODE', {
          message: `r.addNode("${name}", node): node is not a Rail-Node`,
          details: { name },
        });
      }
      const inputList = node.inputs;
      const outputList = node.outputs;

      const consumedPerRail = {};
      for (const rail of inputList) {
        consumedPerRail[rail] = consumeRail(rail, `r.addNode("${name}")`);
      }
      registerNode(name, node);
      for (const rail of inputList) {
        for (const source of consumedPerRail[rail]) {
          wires.push({ source, target: `${name}.${rail}` });
        }
      }
      for (const rail of outputList) {
        noteRail(rail);
        liveSet.push({ rail, source: `${name}.${rail}` });
      }
    },

    label(name, rail) {
      ensureNotSealed('r.label');
      ensureEntriesDeclared('r.label');
      validateName(name, 'r.label');
      validateName(rail, 'r.label rail');

      // A no-op atom: inputs ['in'], outputs [rail], returns rail name.
      const labelNode = atom(
        async () => rail,
        { inputs: ['in'], outputs: [rail] },
      );
      registerNode(name, labelNode);
      labels.set(name, { rail });
      noteRail(rail);
      liveSet.push({ rail, source: `${name}.${rail}` });

      // Resolve pending links.
      const pending = pendingLinks.get(name);
      if (pending) {
        for (const source of pending) {
          wires.push({ source, target: `${name}.in` });
          labelHasIncomingWire.add(name);
        }
        pendingLinks.delete(name);
      }
    },

    link(labelName, rail) {
      ensureNotSealed('r.link');
      ensureEntriesDeclared('r.link');
      // Note: validateName not strictly required here — labelName is matched against
      // existing labels. But we still want to reject reserved characters etc.
      validateName(labelName, 'r.link labelName');
      validateName(rail, 'r.link rail');

      const sources = consumeRail(rail, `r.link("${labelName}", "${rail}")`);
      if (labels.has(labelName)) {
        for (const source of sources) {
          wires.push({ source, target: `${labelName}.in` });
          labelHasIncomingWire.add(labelName);
        }
      } else {
        if (!pendingLinks.has(labelName)) pendingLinks.set(labelName, []);
        const list = pendingLinks.get(labelName);
        for (const source of sources) list.push(source);
      }
    },
  };

  const returned = builderFn(r);
  if (returned !== undefined) {
    throw new RailBuildError('ASYNC_BUILDER', {
      message: 'nrail(builderFn): builder must return undefined (synchronous). Did you pass an async function?',
    });
  }
  sealed = true;

  // ----- Build-end checks -----

  if (pendingLinks.size > 0) {
    const unresolved = [...pendingLinks.keys()];
    throw new RailBuildError('UNKNOWN_LABEL', {
      message: `nrail: unresolved label(s): [${unresolved.join(', ')}]. Known labels: [${[...labels.keys()].join(', ')}]`,
      details: { unresolved, known: [...labels.keys()] },
    });
  }
  for (const labelName of labels.keys()) {
    if (!labelHasIncomingWire.has(labelName)) {
      throw new RailBuildError('UNUSED_LABEL', {
        message: `nrail: label "${labelName}" has no incoming link`,
        details: { label: labelName },
      });
    }
  }

  // ----- Exits from remaining Live-Set -----
  // Exits appear in order of first rail appearance across the build
  // (per §6.8). Skip any rail whose Live-Set entries were fully
  // consumed (no remaining sources).
  const remainingByRail = new Map();
  for (const item of liveSet) {
    if (!remainingByRail.has(item.rail)) remainingByRail.set(item.rail, []);
    remainingByRail.get(item.rail).push(item.source);
  }
  const exitNames = [];
  for (const rail of firstSeenRail) {
    if (remainingByRail.has(rail) && !entrySet.has(rail)) {
      exitNames.push(rail);
    } else if (remainingByRail.has(rail) && entrySet.has(rail)) {
      // Entry rail still live (no consumer ever consumed it). It
      // produces an exit of the same name with a direct entry→exit wire.
      exitNames.push(rail);
    }
  }

  // Build the activity by replaying through activity()'s builder.
  const built = activity((a) => {
    for (const name of entries) a.entry(name);
    for (const sn of subNodes) a.addNode(sn.name, sn.node);
    for (const ex of exitNames) a.exit(ex);
    for (const w of wires) a.wire(w.source, w.target);
    // Wire remaining Live-Set entries to the matching exit.
    for (const [rail, sources] of remainingByRail) {
      for (const source of sources) {
        a.wire(source, `.${rail}`);
      }
    }
  });

  return built;
}

/**
 * `railway(builderFn)` — Trailblazer-style two-track pipeline. See §7.
 *
 * Thin wrapper over nrail. Three builder methods, all with the same
 * user-function signature `fn(ctx, local, runInfo) → void`:
 *
 *   r.step(name, fn) — normal → success; throw → failure (ctx._error set)
 *   r.pass(name, fn) — normal → success; throw → success (ctx._error set)
 *   r.fail(name, fn) — normal → failure; throw → failure (ctx._error set)
 *
 * Resulting activity: inputs `['success']`, outputs `['success','failure']`.
 *
 * @param {(r: object) => void} builderFn
 */
export function railway(builderFn) {
  if (typeof builderFn !== 'function') {
    throw new TypeError('railway(builderFn): builderFn must be a function');
  }
  return nrail((nr) => {
    nr.entry('success');
    const r = {
      step(name, fn) {
        if (typeof fn !== 'function') {
          throw new TypeError(`r.step(name, fn): fn must be a function, got ${typeof fn}`);
        }
        const inner = async (ctx, local, runInfo) => {
          await fn(ctx, local, runInfo);
          return 'success';
        };
        nr.step(name, catchTo(inner, 'failure'), 'success', ['success', 'failure']);
      },
      pass(name, fn) {
        if (typeof fn !== 'function') {
          throw new TypeError(`r.pass(name, fn): fn must be a function, got ${typeof fn}`);
        }
        const inner = async (ctx, local, runInfo) => {
          await fn(ctx, local, runInfo);
          return 'success';
        };
        nr.step(name, catchTo(inner, 'success'), 'success', 'success');
      },
      fail(name, fn) {
        if (typeof fn !== 'function') {
          throw new TypeError(`r.fail(name, fn): fn must be a function, got ${typeof fn}`);
        }
        const inner = async (ctx, local, runInfo) => {
          await fn(ctx, local, runInfo);
          return 'failure';
        };
        nr.step(name, catchTo(inner, 'failure'), 'failure', 'failure');
      },
    };
    const returned = builderFn(r);
    if (returned !== undefined) {
      throw new RailBuildError('ASYNC_BUILDER', {
        message: 'railway(builderFn): builder must return undefined (synchronous). Did you pass an async function?',
      });
    }
  });
}
