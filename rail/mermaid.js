/**
 * Mermaid renderer for rail.js v0.3.0. See spec §2.4, §15.8.
 *
 * Two entry points:
 *   - renderFlowMermaid(flow, opts) — used by `flow.toMermaid(opts)`
 *   - renderActivityMermaid(node, name, opts) — used by `activity.toMermaid`
 *
 * Renderers walk the live `_subNodes`/`_wires` data on activity nodes,
 * and `_branches`/`_merge` on parallel nodes. Pin is render-transparent:
 * the inner node is rendered in pin's place.
 */

function escapeLabel(s) {
  let out = '';
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const code = ch.charCodeAt(0);
    if (code <= 0x1f) {
      out += ' ';
      continue;
    }
    switch (ch) {
      case '&': out += '&amp;'; break;
      case '<': out += '&lt;'; break;
      case '>': out += '&gt;'; break;
      case '"': out += '&quot;'; break;
      case '|': out += '&vert;'; break;
      default:  out += ch;
    }
  }
  return out;
}

function makeIdAllocator() {
  let counter = 0;
  return (prefix = 'n') => `${prefix}${counter++}`;
}

/**
 * Renders an activity at the top level of a Mermaid diagram. Returns
 * a complete Mermaid document.
 *
 * @param {object} node     Activity node
 * @param {string|undefined} name  diagram label (flow name or activity name)
 * @param {object} [opts]
 */
export function renderActivityMermaid(node, name, opts) {
  const direction = opts?.direction ?? 'LR';
  const lines = [`flowchart ${direction}`];
  if (name) lines.push(`  %% ${escapeLabel(name)}`);
  const ids = makeIdAllocator();
  const ctx = { lines, ids, exitIds: [] };

  renderActivityBody(ctx, node, '  ');

  if (ctx.exitIds.length > 0) {
    lines.push(`  classDef exit fill:#eef,stroke:#669,stroke-width:1px;`);
    lines.push(`  class ${ctx.exitIds.join(',')} exit;`);
  }

  return lines.join('\n');
}

/**
 * Renders a flow's diagram. Delegates to the held node's toMermaid hook
 * if present; otherwise renders a minimal default diagram.
 *
 * @param {object} flow
 * @param {object} [opts]
 */
export function renderFlowMermaid(flow, opts) {
  const node = flow.node;
  if (typeof node.toMermaid === 'function') {
    return node.toMermaid(flow.name, opts);
  }
  return renderMinimalTopLevel(flow.name, node, opts);
}

function renderMinimalTopLevel(flowName, node, opts) {
  const direction = opts?.direction ?? 'LR';
  const lines = [`flowchart ${direction}`];
  if (flowName) lines.push(`  %% ${escapeLabel(flowName)}`);
  const ids = makeIdAllocator();
  const entryName = node.inputs[0] ?? 'in';
  const startId = ids('start_');
  lines.push(`  ${startId}(["${escapeLabel(entryName)}"])`);
  const boxId = ids();
  lines.push(`  ${boxId}["${escapeLabel(flowName ?? node.__rail_kind__)}"]`);
  lines.push(`  ${startId} --> ${boxId}`);
  const exitIds = [];
  for (const out of node.outputs) {
    const exitId = ids('endExit_');
    lines.push(`  ${exitId}(["${escapeLabel(out)}"])`);
    lines.push(`  ${boxId} -- "${escapeLabel(out)}" --> ${exitId}`);
    exitIds.push(exitId);
  }
  if (exitIds.length > 0) {
    lines.push(`  classDef exit fill:#eef,stroke:#669,stroke-width:1px;`);
    lines.push(`  class ${exitIds.join(',')} exit;`);
  }
  return lines.join('\n');
}

function renderActivityBody(ctx, node, indent) {
  const subIds = new Map();
  const entryIds = new Map();
  const exitIds = new Map();

  for (const e of node._entries) {
    const id = ctx.ids('start_');
    entryIds.set(e, id);
    ctx.lines.push(`${indent}${id}(["${escapeLabel(e)}"])`);
  }

  for (const sn of node._subNodes) {
    const id = ctx.ids();
    subIds.set(sn.name, id);
    renderSubNode(ctx, sn.node, id, sn.name, indent);
  }

  for (const x of node._exits) {
    const id = ctx.ids('endExit_');
    exitIds.set(x, id);
    ctx.lines.push(`${indent}${id}(["${escapeLabel(x)}"])`);
    ctx.exitIds.push(id);
  }

  for (const w of node._wires) {
    const srcId = w.source.kind === 'entry'
      ? entryIds.get(w.source.port)
      : subIds.get(w.source.subName);
    const tgtId = w.target.kind === 'exit'
      ? exitIds.get(w.target.port)
      : subIds.get(w.target.subName);
    if (w.source.kind === 'entry') {
      ctx.lines.push(`${indent}${srcId} --> ${tgtId}`);
    } else {
      ctx.lines.push(`${indent}${srcId} -- "${escapeLabel(w.source.port)}" --> ${tgtId}`);
    }
  }
}

function renderSubNode(ctx, subNode, id, label, indent) {
  const kind = subNode.__rail_kind__;
  if (kind === 'activity') {
    ctx.lines.push(`${indent}subgraph ${id} ["${escapeLabel(label)}"]`);
    renderActivityBody(ctx, subNode, indent + '  ');
    ctx.lines.push(`${indent}end`);
    return;
  }
  if (kind === 'parallel') {
    ctx.lines.push(`${indent}subgraph ${id} ["parallel"]`);
    renderParallelBody(ctx, subNode, indent + '  ');
    ctx.lines.push(`${indent}end`);
    return;
  }
  if (kind === 'pin') {
    renderSubNode(ctx, subNode._inner, id, label, indent);
    return;
  }
  ctx.lines.push(`${indent}${id}["${escapeLabel(label)}"]`);
}

function renderParallelBody(ctx, node, indent) {
  const branchIds = new Map();
  for (const branchName of Object.keys(node._branches)) {
    const branchNode = node._branches[branchName];
    const id = ctx.ids();
    branchIds.set(branchName, id);
    renderSubNode(ctx, branchNode, id, branchName, indent);
  }
  if (node._merge) {
    const mergeId = ctx.ids();
    renderSubNode(ctx, node._merge, mergeId, '__merge__', indent);
    for (const id of branchIds.values()) {
      ctx.lines.push(`${indent}${id} --> ${mergeId}`);
    }
  }
}
