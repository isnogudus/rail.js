/**
 * Mermaid renderers. See spec §3.11.
 *
 * Produces `flowchart LR` (or TB) strings with the conventions:
 *   - Entry  → `start([entry-name])`
 *   - Sub-Node by railKind:
 *       step      → `id["name"]`              (rectangle)
 *       activity  → `id[[name]]:::subActivity`(subroutine; not expanded)
 *       parallel  → `id{{name}}:::parallelNode`(distinct marker; not expanded)
 *   - Exit   → `endExit_<name>([<exit-name>]):::exit`
 *   - Wire   → labeled with source's output port (unlabeled for entry wire)
 */

const RESERVED_CLASSES = [
  'classDef subActivity fill:#eef,stroke:#88d',
  'classDef parallelNode fill:#efe,stroke:#8d8',
  'classDef exit fill:#fee,stroke:#d88',
];

function sanitizeId(s) {
  return String(s).replace(/[^a-zA-Z0-9_]/g, '_');
}

function escapeLabel(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function direction(opts) {
  return opts?.direction === 'TB' ? 'TB' : 'LR';
}

function nodeShape(railKind, id, label) {
  if (railKind === 'activity') return `${id}[[${label}]]:::subActivity`;
  if (railKind === 'parallel') return `${id}{{${label}}}:::parallelNode`;
  return `${id}["${label}"]`;
}

/**
 * Renders an Activity's internal topology.
 *
 * @param {object} activity  An Activity node (with `_state`).
 * @param {string} [name]    Optional label for the diagram.
 * @param {object} [opts]    Render options.
 * @returns {string}
 */
export function renderActivityToMermaid(activity, name = '<anonymous>', opts = {}) {
  const state = activity._state;
  if (!state) {
    throw new Error('renderActivityToMermaid: missing internal state');
  }

  const lines = [`flowchart ${direction(opts)}`];

  if (state.entries.length > 0) {
    const entryName = state.entries[0].name;
    lines.push(`  start([${escapeLabel(entryName)}])`);
  }

  for (const sn of state.subNodes) {
    if (!sn.valid) continue;
    const id = `n_${sanitizeId(sn.name)}`;
    const label = escapeLabel(sn.name);
    lines.push(`  ${nodeShape(sn.node.railKind, id, label)}`);
  }

  const seenExitId = new Set();
  for (const e of state.exits) {
    const id = `endExit_${sanitizeId(e.name)}`;
    if (seenExitId.has(id)) continue;
    seenExitId.add(id);
    lines.push(`  ${id}([${escapeLabel(e.name)}]):::exit`);
  }

  for (const w of state.wires) {
    let srcId;
    let label = '';
    if (w.sourceKey === '__entry__') {
      srcId = 'start';
    } else {
      const m = w.sourceKey.match(/^node:(.+?)\.(.+)$/);
      const sName = m[1];
      const port = m[2];
      srcId = `n_${sanitizeId(sName)}`;
      label = port;
    }

    let tgtId;
    if (w.targetDesc.kind === 'exit') {
      tgtId = `endExit_${sanitizeId(w.targetDesc.name)}`;
    } else {
      tgtId = `n_${sanitizeId(w.targetDesc.name)}`;
    }

    if (label) {
      lines.push(`  ${srcId} -- "${escapeLabel(label)}" --> ${tgtId}`);
    } else {
      lines.push(`  ${srcId} --> ${tgtId}`);
    }
  }

  for (const c of RESERVED_CLASSES) lines.push(`  ${c}`);
  return lines.join('\n');
}

/**
 * Renders a top-level Step-Node as a minimal diagram.
 *
 * @param {object} step
 * @param {string} [name]
 * @param {object} [opts]
 * @returns {string}
 */
export function renderStepToMermaid(step, name = '<anonymous>', opts = {}) {
  const lines = [`flowchart ${direction(opts)}`];
  const inputName = step.inputs?.[0] ?? 'in';
  lines.push(`  start([${escapeLabel(inputName)}])`);
  const id = `n_${sanitizeId(name)}`;
  lines.push(`  ${id}["${escapeLabel(name)}"]`);
  lines.push(`  start --> ${id}`);
  for (const out of step.outputs) {
    const exitId = `endExit_${sanitizeId(out)}`;
    lines.push(`  ${exitId}([${escapeLabel(out)}]):::exit`);
    lines.push(`  ${id} -- "${escapeLabel(out)}" --> ${exitId}`);
  }
  lines.push('  classDef exit fill:#fee,stroke:#d88');
  return lines.join('\n');
}

/**
 * Renders a top-level Parallel-Node as a minimal diagram.
 *
 * @param {object} parallel
 * @param {string} [name]
 * @param {object} [opts]
 * @returns {string}
 */
export function renderParallelToMermaid(parallel, name = '<anonymous>', opts = {}) {
  const lines = [`flowchart ${direction(opts)}`];
  const inputName = parallel.inputs?.[0] ?? 'in';
  lines.push(`  start([${escapeLabel(inputName)}])`);
  const id = `n_${sanitizeId(name)}`;
  lines.push(`  ${id}{{${escapeLabel(name)}}}:::parallelNode`);
  lines.push(`  start --> ${id}`);
  for (const out of parallel.outputs) {
    const exitId = `endExit_${sanitizeId(out)}`;
    lines.push(`  ${exitId}([${escapeLabel(out)}]):::exit`);
    lines.push(`  ${id} -- "${escapeLabel(out)}" --> ${exitId}`);
  }
  lines.push('  classDef parallelNode fill:#efe,stroke:#8d8');
  lines.push('  classDef exit fill:#fee,stroke:#d88');
  return lines.join('\n');
}

/**
 * Dispatches by railKind.
 *
 * @param {object} node
 * @param {string} [name]
 * @param {object} [opts]
 */
export function renderNodeToMermaid(node, name, opts) {
  switch (node.railKind) {
    case 'activity': return renderActivityToMermaid(node, name, opts);
    case 'step': return renderStepToMermaid(node, name, opts);
    case 'parallel': return renderParallelToMermaid(node, name, opts);
    default:
      throw new Error(`renderNodeToMermaid: unknown railKind '${node.railKind}'`);
  }
}
