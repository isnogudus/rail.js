/**
 * Generic Mermaid-rendered diagram engine with animated playback.
 *
 *   const diag = await createDiagram('container-id', graphDef, 'svgId');
 *   await diag.play(steps, { terminus, onStepComplete });
 *
 * `steps` is an array of `{ node, output?, errored?, duration?, traceEntries? }`.
 * For composite nodes (sub-activities, parallel-nodes) the `traceEntries`
 * field carries the trace rows that should be revealed when the diagram
 * reaches that step.
 */

import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';

/* ------------------------------------------------------------------ */
/* Mermaid initialisation                                             */
/* ------------------------------------------------------------------ */

mermaid.initialize({
  startOnLoad: false,
  theme: 'base',
  themeVariables: {
    background: 'transparent',
    primaryColor: '#fbf8f1',
    primaryBorderColor: '#1a1815',
    primaryTextColor: '#1a1815',
    secondaryColor: '#efe9dc',
    tertiaryColor: '#fbf8f1',
    lineColor: '#a89e8b',
    fontFamily: 'JetBrains Mono, ui-monospace, monospace',
    fontSize: '13px',
  },
  flowchart: {
    htmlLabels: true,
    curve: 'basis',
    nodeSpacing: 36,
    rankSpacing: 56,
    padding: 8,
  },
});

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

const SVG_NS = 'http://www.w3.org/2000/svg';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function renderInto(container, id, graphDef) {
  const { svg: svgText } = await mermaid.render(id, graphDef);
  container.innerHTML = svgText;
  return container.querySelector('svg');
}

/**
 * Parses a Mermaid `flowchart` graph definition into a list of wires
 * in declaration order. Mermaid assigns the wire's index as the
 * trailing `_N` on the rendered path id (`L_<src>_<tgt>_<N>`); we
 * rely on that match to associate paths with labels even when two
 * wires share the same source/target pair (multi-input nodes).
 *
 * Supported edge forms:
 *   src -- "label" --> tgt
 *   src -->|label| tgt
 *   src --> tgt
 */
function parseWires(graphDef) {
  const wires = [];
  if (typeof graphDef !== 'string') return wires;
  for (const raw of graphDef.split('\n')) {
    const line = raw.trim();
    // Skip declarations, classDefs, comments, etc.
    if (!line || /^(flowchart|graph|classDef|click|subgraph|end|%%)/.test(line)) continue;
    let m =
      line.match(/^([A-Za-z0-9_-]+)\s*--\s*"([^"]*)"\s*-->\s*([A-Za-z0-9_-]+)/) ||
      line.match(/^([A-Za-z0-9_-]+)\s*-->\s*\|([^|]*)\|\s*([A-Za-z0-9_-]+)/);
    if (m) { wires.push({ src: m[1], label: m[2], tgt: m[3] }); continue; }
    m = line.match(/^([A-Za-z0-9_-]+)\s*-->\s*([A-Za-z0-9_-]+)/);
    if (m) { wires.push({ src: m[1], label: '', tgt: m[2] }); }
  }
  return wires;
}

function buildMaps(svg, graphDef) {
  const nodeById = new Map();
  for (const g of svg.querySelectorAll('g.node')) {
    const id = g.getAttribute('id') || '';
    const m = id.match(/(?:^|-)flowchart-(.+?)-\d+$/);
    if (m) nodeById.set(m[1], g);
  }
  const knownIds = [...nodeById.keys()];

  const wires = parseWires(graphDef);

  // Two-level lookup: edges[src->tgt] is a Map<label, path>. The
  // wire's declaration index — encoded in Mermaid's path id as the
  // trailing `_N` — is what associates a path with its label.
  const edgeBySrcTgt = new Map();

  for (const p of svg.querySelectorAll('path.flowchart-link, g.edgePaths > path, g.edgePath path')) {
    const id = p.getAttribute('id') || '';
    const m = id.match(/L_(.+)_(\d+)$/);
    if (!m) continue;
    const middle = m[1];
    const idx = Number(m[2]);
    for (const src of knownIds) {
      const sep = src + '_';
      if (middle.startsWith(sep)) {
        const tgt = middle.slice(sep.length);
        if (!nodeById.has(tgt)) continue;
        const wire = wires[idx];
        const label = wire?.label ?? '';
        const key = `${src}->${tgt}`;
        if (!edgeBySrcTgt.has(key)) edgeBySrcTgt.set(key, new Map());
        edgeBySrcTgt.get(key).set(label, p);
        break;
      }
    }
  }

  console.log('[rail.js diagrams] map built', {
    nodes: [...nodeById.keys()],
    edges: [...edgeBySrcTgt.keys()].map((k) => `${k} (${[...edgeBySrcTgt.get(k).keys()].join('|')})`),
  });
  return { nodeById, edgeBySrcTgt };
}

/**
 * Looks up the SVG path for a wire src→tgt with the given output
 * label. Falls back to the unlabeled or first available variant if no
 * exact match is found (e.g. for the entry wire which carries no
 * label).
 */
function findEdge(maps, src, tgt, label) {
  const byLabel = maps.edgeBySrcTgt.get(`${src}->${tgt}`);
  if (!byLabel) return null;
  if (label != null && byLabel.has(label)) return byLabel.get(label);
  if (byLabel.has('')) return byLabel.get('');
  // Last resort: first available. Avoids hard-fail on label mismatch.
  return byLabel.values().next().value ?? null;
}

/* ------------------------------------------------------------------ */
/* State application                                                  */
/* ------------------------------------------------------------------ */

const NODE_STATE_STYLES = {
  active:         { fill: 'var(--rail-soft)', stroke: 'var(--rail)', strokeWidth: '3px' },
  completed:      { fill: 'var(--rail-soft)', stroke: 'var(--rail)', strokeWidth: '2px' },
  errored:        { fill: 'var(--clay-soft)', stroke: 'var(--clay)', strokeWidth: '3px' },
  reached:        { fill: 'var(--rail)',      stroke: 'var(--rail)', strokeWidth: '3px' },
  'reached-fail': { fill: 'var(--clay)',      stroke: 'var(--clay)', strokeWidth: '3px' },
};

const EDGE_STATE_STYLES = {
  traversed:        { stroke: 'var(--rail)', strokeWidth: '2.5px' },
  'traversed-fail': { stroke: 'var(--clay)', strokeWidth: '2.5px' },
};

const NODE_VIZ_CLASSES = ['viz-active', 'viz-completed', 'viz-errored', 'viz-reached', 'viz-reached-fail'];
const EDGE_VIZ_CLASSES = ['viz-traversed', 'viz-traversed-fail'];

function shapeChildrenOf(nodeEl) {
  const all = nodeEl.querySelectorAll('rect, polygon, circle, path, ellipse');
  return Array.from(all).filter((el) => !el.closest('g.label'));
}

function setNodeState(nodeEl, state) {
  if (!nodeEl) return;
  nodeEl.classList.remove(...NODE_VIZ_CLASSES);
  if (state) nodeEl.classList.add(`viz-${state}`);

  const styles = state ? NODE_STATE_STYLES[state] : null;
  for (const shape of shapeChildrenOf(nodeEl)) {
    if (styles) {
      shape.style.setProperty('fill',         styles.fill,        'important');
      shape.style.setProperty('stroke',       styles.stroke,      'important');
      shape.style.setProperty('stroke-width', styles.strokeWidth, 'important');
    } else {
      shape.style.removeProperty('fill');
      shape.style.removeProperty('stroke');
      shape.style.removeProperty('stroke-width');
    }
  }
}

function setEdgeState(pathEl, state) {
  if (!pathEl) return;
  pathEl.classList.remove(...EDGE_VIZ_CLASSES);
  if (state) pathEl.classList.add(`viz-${state}`);

  const styles = state ? EDGE_STATE_STYLES[state] : null;
  if (styles) {
    pathEl.style.setProperty('stroke',       styles.stroke,      'important');
    pathEl.style.setProperty('stroke-width', styles.strokeWidth, 'important');
  } else {
    pathEl.style.removeProperty('stroke');
    pathEl.style.removeProperty('stroke-width');
  }
}

function clearViz(svg) {
  if (!svg) return;
  for (const nodeEl of svg.querySelectorAll('g.node')) setNodeState(nodeEl, null);
  for (const pathEl of svg.querySelectorAll('path.flowchart-link, g.edgePath path, g.edgePaths path')) {
    setEdgeState(pathEl, null);
  }
  for (const t of svg.querySelectorAll('circle.token')) t.remove();
}

/* ------------------------------------------------------------------ */
/* Animation                                                          */
/* ------------------------------------------------------------------ */

function animateToken(svg, path, opts = {}) {
  return new Promise((resolve) => {
    if (!path) { resolve(); return; }
    const { fail = false, duration = 700 } = opts;

    const token = document.createElementNS(SVG_NS, 'circle');
    token.setAttribute('class', fail ? 'token fail' : 'token');
    token.setAttribute('r', '7');
    svg.appendChild(token);

    const length = path.getTotalLength();
    const start = performance.now();

    function frame(now) {
      const t = Math.min(1, (now - start) / duration);
      const pt = path.getPointAtLength(t * length);
      token.setAttribute('cx', String(pt.x));
      token.setAttribute('cy', String(pt.y));
      if (t < 1) requestAnimationFrame(frame);
      else { token.remove(); resolve(); }
    }
    requestAnimationFrame(frame);
  });
}

/* ------------------------------------------------------------------ */
/* Playback engine                                                    */
/* ------------------------------------------------------------------ */

function holdMsFor(durationMs) {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) return 500;
  return Math.max(300, Math.min(1500, durationMs * 7));
}

const EDGE_TRAVEL_MS = 650;

async function playFlow(svg, maps, steps, opts = {}) {
  const { terminus = null, signal, onStepComplete } = opts;
  clearViz(svg);
  if (steps.length === 0) return;

  const aborted = () => signal?.aborted;

  const firstNode = steps[0].node;
  const entryEdge = findEdge(maps, 'start', firstNode, '');
  if (entryEdge) {
    setEdgeState(entryEdge, 'traversed');
    await animateToken(svg, entryEdge, { duration: EDGE_TRAVEL_MS });
  }
  if (aborted()) return;
  setNodeState(maps.nodeById.get(firstNode), 'active');

  for (let i = 0; i < steps.length; i++) {
    if (aborted()) return;
    const step = steps[i];
    const nodeEl = maps.nodeById.get(step.node);

    await sleep(holdMsFor(step.duration));
    if (aborted()) return;

    if (step.errored) {
      setNodeState(nodeEl, 'errored');
      onStepComplete?.(i);
      return;
    }

    setNodeState(nodeEl, 'completed');
    onStepComplete?.(i);

    const next = steps[i + 1];
    const tgt = next
      ? next.node
      : (terminus ? `endExit_${terminus}` : null);
    if (!tgt) continue;

    const isFailPath = terminus && terminus !== 'success' && terminus !== 'ok';
    // The wire taken is identified by this step's output label —
    // necessary to disambiguate parallel wires between the same two
    // nodes (e.g. trigger -[retry]→ recover  vs.  trigger -[skip]→ recover).
    const edge = findEdge(maps, step.node, tgt, step.output);
    if (edge) {
      setEdgeState(edge, isFailPath ? 'traversed-fail' : 'traversed');
      await animateToken(svg, edge, { fail: isFailPath, duration: EDGE_TRAVEL_MS });
    }
    if (aborted()) return;

    const tgtEl = maps.nodeById.get(tgt);
    if (!tgtEl) continue;
    if (!next) {
      setNodeState(tgtEl, isFailPath ? 'reached-fail' : 'reached');
    } else {
      setNodeState(tgtEl, 'active');
    }
  }
}

/* ------------------------------------------------------------------ */
/* Public factory                                                     */
/* ------------------------------------------------------------------ */

/**
 * Renders the given Mermaid graph into the container element with the
 * given ID, then returns an object that can replay step sequences
 * through the rendered SVG.
 *
 * @param {string} containerId   DOM id of the host element (a <div>)
 * @param {string} graphDef       Mermaid flowchart definition
 * @param {string} [diagramId]    Optional id passed to mermaid.render
 *                                (defaults to "svg-<containerId>")
 */
export async function createDiagram(containerId, graphDef, diagramId) {
  const container = document.getElementById(containerId);
  if (!container) return null;

  const svg = await renderInto(container, diagramId ?? `svg-${containerId}`, graphDef);
  const maps = buildMaps(svg, graphDef);
  let currentAbort = null;

  return {
    svg,
    maps,
    /** Run a playback. Cancels any in-flight playback first. */
    async play(steps, opts = {}) {
      currentAbort?.abort();
      currentAbort = new AbortController();
      await playFlow(svg, maps, steps, { ...opts, signal: currentAbort.signal });
    },
    cancel() { currentAbort?.abort(); },
  };
}

/**
 * Groups a rail.js v0.3 trace (push-order = pre-order DFS) by diagram
 * node. Each step in `diagramSteps` gains a `traceEntries` array.
 *
 * For each diagram step (in declaration order):
 *   1. Skip ahead past trace entries that don't belong to this step.
 *   2. Take the first matching entry (either the wrapper
 *      `step === actName`, or a sub-step `step.startsWith(actName + '.')`).
 *   3. If the matched entry was the wrapper, also drain following
 *      sub-step entries until a non-matching entry appears.
 *
 * This shape handles:
 *   - flat traces (each diagram step → one trace entry),
 *   - sub-activities (one diagram step → wrapper + many sub-entries),
 *   - loops (the same node listed multiple times → one entry per cycle).
 *
 * @param {Array<{step: string}>} trace
 * @param {Array<{node: string}>} diagramSteps
 * @returns {Array} Same shape as diagramSteps, with `traceEntries`.
 */
export function groupTraceForDiagram(trace, diagramSteps) {
  let i = 0;
  return diagramSteps.map((step) => {
    const actName = String(step.node).replace(/^n_/, '');
    const entries = [];

    while (
      i < trace.length &&
      trace[i].step !== actName &&
      !trace[i].step.startsWith(actName + '.')
    ) {
      i++;
    }

    if (i < trace.length) {
      const first = trace[i];
      entries.push(first);
      i++;
      if (first.step === actName) {
        while (i < trace.length && trace[i].step.startsWith(actName + '.')) {
          entries.push(trace[i]);
          i++;
        }
      }
    }

    return { ...step, traceEntries: entries };
  });
}
