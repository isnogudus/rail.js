/**
 * Custom SVG diagrams for rail.js — hand-positioned nodes, smooth
 * cubic-bezier wires, and a small token that runs along the active
 * path to visualise an execution.
 *
 * Two builders run on page load:
 *   - buildHero():  small auto-looping diagram in the hero card
 *   - buildDemo():  bigger diagram driven by the actual rail.js Run-State
 *                   (see demo.js, which imports `playDemo` from here)
 */

const NS = 'http://www.w3.org/2000/svg';

/* ------------------------------------------------------------------ */
/* SVG helpers                                                        */
/* ------------------------------------------------------------------ */

function el(tag, attrs = {}, ...children) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null) e.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

/** Cubic bezier from (x1,y1) to (x2,y2), curved horizontally. */
function curvePath(x1, y1, x2, y2) {
  const cx = Math.abs(x2 - x1) * 0.5;
  return `M ${x1} ${y1} C ${x1 + cx} ${y1}, ${x2 - cx} ${y2}, ${x2} ${y2}`;
}

function nodeBox(x, y, w, h, label) {
  const g = el('g', { transform: `translate(${x},${y})`, 'data-node': label });
  g.appendChild(el('rect', {
    class: 'node-rect',
    x: 0, y: 0, width: w, height: h, rx: 4, ry: 4,
  }));
  g.appendChild(el('text', {
    class: 'node-text',
    x: w / 2, y: h / 2 + 4.5,
    'text-anchor': 'middle',
  }, label));
  return g;
}

function endpoint(x, y, kind, label) {
  const g = el('g', { transform: `translate(${x},${y})`, 'data-endpoint': kind });
  let cls = 'endpoint-circle entry-circle';
  if (kind === 'success') cls = 'endpoint-circle exit-success';
  if (kind === 'failure') cls = 'endpoint-circle exit-failure';
  g.appendChild(el('circle', { class: cls, cx: 0, cy: 0, r: 16 }));
  g.appendChild(el('text', {
    class: 'node-text',
    x: 0, y: 4,
    'text-anchor': 'middle',
    style: 'font-size: 10px;',
  }, label));
  return g;
}

function wire(x1, y1, x2, y2, label = null, dotted = false, labelDy = 0) {
  const g = el('g');
  const path = el('path', {
    class: dotted ? 'wire dotted' : 'wire',
    d: curvePath(x1, y1, x2, y2),
  });
  g.appendChild(path);
  if (label) {
    const lx = (x1 + x2) / 2;
    const ly = (y1 + y2) / 2 - 4 + labelDy;
    const w = label.length * 6.4 + 8;
    g.appendChild(el('rect', {
      class: 'wire-label-bg',
      x: lx - w / 2, y: ly - 9,
      width: w, height: 13, rx: 2,
    }));
    g.appendChild(el('text', {
      class: 'wire-label',
      x: lx, y: ly,
      'text-anchor': 'middle',
    }, label));
  }
  return { g, path };
}

/* ------------------------------------------------------------------ */
/* Animation primitives                                               */
/* ------------------------------------------------------------------ */

function clearTokens(svg) {
  svg.querySelectorAll('circle.token').forEach((t) => t.remove());
}

function clearHighlights(svg) {
  svg.querySelectorAll('path.wire').forEach((p) => {
    p.classList.remove('active', 'fail-active');
  });
  svg.querySelectorAll('rect.node-rect').forEach((r) => {
    r.classList.remove('active', 'errored');
  });
  svg.querySelectorAll('circle.endpoint-circle').forEach((c) => {
    c.classList.remove('reached', 'success', 'failure');
  });
}

function highlightWires(svg, ids, kind = 'active') {
  for (const id of ids) {
    const p = svg.querySelector(`path[data-wire="${id}"]`);
    if (p) p.classList.add(kind === 'fail' ? 'fail-active' : 'active');
  }
}

/**
 * Animate a small token (circle) along a sequence of <path> elements.
 * Resolves when the last point is reached.
 *
 * @param {SVGSVGElement} svg
 * @param {SVGPathElement[]} paths
 * @param {{ fail?: boolean, failAtSegment?: number, speed?: number }} [opts]
 */
function animateToken(svg, paths, opts = {}) {
  return new Promise((resolve) => {
    if (paths.length === 0 || paths.some((p) => !p)) { resolve(); return; }
    const token = el('circle', {
      class: opts.fail ? 'token fail' : 'token',
      r: 7, cx: 0, cy: 0,
    });
    svg.appendChild(token);

    const lengths = paths.map((p) => p.getTotalLength());
    const total = lengths.reduce((s, l) => s + l, 0);
    const speed = opts.speed ?? 0.35; // px per ms
    const dur = Math.max(total / speed, 200);
    const t0 = performance.now();

    function frame(now) {
      const t = Math.min(1, (now - t0) / dur);
      let traveled = t * total;
      let segIdx = 0;
      while (segIdx < paths.length - 1 && traveled > lengths[segIdx]) {
        traveled -= lengths[segIdx];
        segIdx++;
      }
      const pt = paths[segIdx].getPointAtLength(Math.min(traveled, lengths[segIdx]));
      token.setAttribute('cx', pt.x);
      token.setAttribute('cy', pt.y);
      if (opts.failAtSegment != null && segIdx >= opts.failAtSegment) {
        token.setAttribute('class', 'token fail');
      }
      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        token.remove();
        resolve();
      }
    }
    requestAnimationFrame(frame);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------------------------------------------ */
/* Common layout for sendMessage diagrams                             */
/* ------------------------------------------------------------------ */

function buildSendMessageInto(svg, opts = {}) {
  const { width = 520, height = 340 } = opts;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  while (svg.firstChild) svg.firstChild.remove();

  // Layout — proportionally derived from the viewBox so we can reuse for
  // hero (smaller) and demo (bigger).
  const cx = (rel) => Math.round(rel * width);
  const cy = (rel) => Math.round(rel * height);

  const E   = { x: cx(0.06),  y: cy(0.50)  };
  const V   = { x: cx(0.18),  y: cy(0.45),  w: cx(0.16), h: cy(0.13) };
  const C   = { x: cx(0.42),  y: cy(0.45),  w: cx(0.16), h: cy(0.13) };
  const S   = { x: cx(0.66),  y: cy(0.45),  w: cx(0.16), h: cy(0.13) };
  const OK  = { x: cx(0.93),  y: cy(0.16)  };
  const FAIL = { x: cx(0.93), y: cy(0.84)  };

  const wires = [
    { id: 'entry',    from: [E.x + 16,        E.y],                 to: [V.x,          V.y + V.h / 2] },
    { id: 'v_ok',     from: [V.x + V.w,       V.y + V.h / 2 - 2],   to: [C.x,          C.y + C.h / 2 - 2], label: 'ok' },
    { id: 'v_invalid',from: [V.x + V.w,       V.y + V.h / 2 + 5],   to: [FAIL.x - 16,  FAIL.y - 6],        label: 'invalid' },
    { id: 'c_ok',     from: [C.x + C.w,       C.y + C.h / 2 - 2],   to: [S.x,          S.y + S.h / 2 - 2], label: 'ok' },
    { id: 'c_noKeys', from: [C.x + C.w,       C.y + C.h / 2 + 5],   to: [FAIL.x - 16,  FAIL.y - 2],        label: 'noKeys' },
    { id: 's_ok',     from: [S.x + S.w,       S.y + S.h / 2 - 2],   to: [OK.x - 16,    OK.y + 6],          label: 'ok' },
    { id: 's_5xx',    from: [S.x + S.w,       S.y + S.h / 2 + 5],   to: [FAIL.x - 16,  FAIL.y + 2],        label: 'net5xx' },
    { id: 's_throws', from: [S.x + S.w / 2,   S.y],                 to: [FAIL.x - 10,  FAIL.y - 14],       dotted: true, label: 'throws' },
  ];

  for (const w of wires) {
    const { g, path } = wire(w.from[0], w.from[1], w.to[0], w.to[1], w.label, w.dotted, w.labelDy ?? 0);
    path.setAttribute('data-wire', w.id);
    svg.appendChild(g);
  }

  svg.appendChild(endpoint(E.x, E.y, 'entry', 'in'));
  svg.appendChild(nodeBox(V.x, V.y, V.w, V.h, 'validate'));
  svg.appendChild(nodeBox(C.x, C.y, C.w, C.h, 'encrypt'));
  svg.appendChild(nodeBox(S.x, S.y, S.w, S.h, 'send'));
  svg.appendChild(endpoint(OK.x,   OK.y,   'success', 'ok'));
  svg.appendChild(endpoint(FAIL.x, FAIL.y, 'failure', 'fail'));
}

/* ------------------------------------------------------------------ */
/* Hero diagram — auto-loops scenarios until the user clicks one      */
/* ------------------------------------------------------------------ */

const SCENARIO_WIRES = {
  happy:   { ids: ['entry', 'v_ok', 'c_ok', 's_ok'],    fail: false },
  invalid: { ids: ['entry', 'v_invalid'],                fail: true },
  net5xx:  { ids: ['entry', 'v_ok', 'c_ok', 's_5xx'],   fail: true },
  throws:  { ids: ['entry', 'v_ok', 'c_ok', 's_throws'], fail: true },
};

function setNodeStateForScenario(svg, scenario, isThrow) {
  // Light up nodes that the scenario actually visits.
  const visited = new Set();
  for (const wireId of SCENARIO_WIRES[scenario].ids) {
    if (wireId === 'entry')                       visited.add('validate');
    if (wireId.startsWith('v_'))                  visited.add('validate');
    if (wireId === 'v_ok')                        visited.add('encrypt');
    if (wireId.startsWith('c_'))                  visited.add('encrypt');
    if (wireId === 'c_ok')                        visited.add('send');
    if (wireId.startsWith('s_'))                  visited.add('send');
  }
  for (const name of visited) {
    const rect = svg.querySelector(`g[data-node="${name}"] rect`);
    if (!rect) continue;
    if (isThrow && name === 'send') rect.classList.add('errored');
    else                            rect.classList.add('active');
  }
}

function markEndpointReached(svg, scenario) {
  const fail = SCENARIO_WIRES[scenario].fail;
  const which = fail ? 'failure' : 'success';
  const circle = svg.querySelector(`g[data-endpoint="${which}"] circle`);
  if (circle) circle.classList.add('reached', which);
}

async function playScenarioOn(svg, scenario) {
  clearTokens(svg);
  clearHighlights(svg);
  const { ids, fail } = SCENARIO_WIRES[scenario];

  highlightWires(svg, ids, fail ? 'fail' : 'active');
  setNodeStateForScenario(svg, scenario, scenario === 'throws');

  const paths = ids.map((id) => svg.querySelector(`path[data-wire="${id}"]`));
  await animateToken(svg, paths, {
    fail,
    speed: 0.4,
  });

  markEndpointReached(svg, scenario);
}

function buildHero() {
  const svg = document.getElementById('hero-diagram');
  if (!svg) return;
  buildSendMessageInto(svg, { width: 520, height: 340 });

  const buttons = document.querySelectorAll('[data-hero]');
  let userInteracted = false;

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      userInteracted = true;
      buttons.forEach((b) => { b.classList.add('ghost'); b.classList.remove('active'); });
      btn.classList.remove('ghost'); btn.classList.add('active');
      playScenarioOn(svg, btn.dataset.hero);
    });
  });

  // Auto-loop until first interaction.
  (async () => {
    const seq = ['happy', 'invalid', 'net5xx', 'throws'];
    let i = 0;
    while (!userInteracted) {
      const s = seq[i % seq.length];
      buttons.forEach((b) => { b.classList.add('ghost'); b.classList.remove('active'); });
      const target = document.querySelector(`[data-hero="${s}"]`);
      if (target) { target.classList.remove('ghost'); target.classList.add('active'); }
      await playScenarioOn(svg, s);
      await sleep(1100);
      if (userInteracted) break;
      i++;
    }
  })();
}

/* ------------------------------------------------------------------ */
/* Live demo diagram — exposes playDemo() for demo.js                 */
/* ------------------------------------------------------------------ */

let demoSvg = null;

function buildDemo() {
  demoSvg = document.getElementById('demo-diagram');
  if (!demoSvg) return;
  buildSendMessageInto(demoSvg, { width: 720, height: 360 });
}

/**
 * Translate a rail.js trace + terminus into the wire IDs to traverse,
 * then animate them in sequence.
 *
 * @param {Array<{step: string, output: string|null, threw: boolean}>} trace
 * @param {string|null} terminus
 * @param {boolean} errored
 */
export async function playDemo(trace, terminus, errored) {
  if (!demoSvg) return;

  const ids = ['entry'];
  let failAtSegment = null;

  for (let i = 0; i < trace.length; i++) {
    const e = trace[i];
    if (e.threw) {
      // For our sendMessage demo we treat any throw as "send throws"
      // (only the catching-wrapped send can produce a non-mapped throw
      // in this graph; other throws would come from validate/encrypt
      // and we approximate them as send-throws visually).
      if (e.step === 'send') {
        ids.push('s_throws');
      }
      failAtSegment = ids.length - 1;
      break;
    }
    // step.output → wire id
    let wireId;
    switch (`${e.step}/${e.output}`) {
      case 'validate/ok':       wireId = 'v_ok';     break;
      case 'validate/invalid':  wireId = 'v_invalid'; break;
      case 'encrypt/ok':        wireId = 'c_ok';     break;
      case 'encrypt/noKeys':    wireId = 'c_noKeys'; break;
      case 'send/ok':           wireId = 's_ok';     break;
      case 'send/net5xx':       wireId = 's_5xx';    break;
      default:                  wireId = null;
    }
    if (wireId) ids.push(wireId);
  }

  // Determine end-state classification for highlighting + endpoint.
  const isFailPath = errored || (terminus && terminus !== 'success');

  clearTokens(demoSvg);
  clearHighlights(demoSvg);
  highlightWires(demoSvg, ids, isFailPath ? 'fail' : 'active');

  // Light up visited nodes.
  const visited = new Set();
  for (const id of ids) {
    if (id === 'entry')                  visited.add('validate');
    if (id.startsWith('v_'))             visited.add('validate');
    if (id === 'v_ok')                   visited.add('encrypt');
    if (id.startsWith('c_'))             visited.add('encrypt');
    if (id === 'c_ok')                   visited.add('send');
    if (id.startsWith('s_'))             visited.add('send');
  }
  for (const name of visited) {
    const rect = demoSvg.querySelector(`g[data-node="${name}"] rect`);
    if (!rect) continue;
    if (errored && name === 'send') rect.classList.add('errored');
    else                            rect.classList.add('active');
  }

  const paths = ids.map((id) => demoSvg.querySelector(`path[data-wire="${id}"]`));
  await animateToken(demoSvg, paths, {
    fail: isFailPath,
    failAtSegment,
    speed: 0.42,
  });

  // Reach endpoint (only if the run actually terminated normally — on a
  // graph error there's no exit reached).
  if (terminus) {
    const which = terminus === 'success' ? 'success' : 'failure';
    const circle = demoSvg.querySelector(`g[data-endpoint="${which}"] circle`);
    if (circle) circle.classList.add('reached', which);
  }
}

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

buildHero();
buildDemo();
