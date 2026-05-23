/**
 * Live demos for rail.js v0.3.0. Each example bootstraps:
 *
 *   1. A real Rail-Node (railway / nrail / activity / parallel).
 *   2. A Mermaid graph definition rendered into the section's
 *      `.diagram-host` element via `createDiagram`.
 *   3. Scenario buttons that run the flow and animate the resulting
 *      trace through the diagram. Trace rows are revealed iteratively
 *      in sync with the diagram playback.
 */

import {
  activity, nrail, railway, parallel, atom, step, pass, fail, pin, catchTo,
  flow,
} from '@isnogudus/rail.js';

import { createDiagram, groupTraceForDiagram } from './diagrams.js';

/* ================================================================== */
/* Shared helpers                                                     */
/* ================================================================== */

function rand(min, max) { return min + Math.random() * (max - min); }
function delay(min, max) { return new Promise((r) => setTimeout(r, rand(min, max))); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
const noLog = () => {};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function formatJson(value) {
  // Render Error instances as { name, message } so JSON.stringify doesn't drop them.
  const replacer = (_k, v) =>
    v instanceof Error ? { name: v.name, message: v.message } : v;
  return JSON.stringify(value, replacer, 2);
}

function renderInput(el, value) {
  if (!el) return;
  el.innerHTML = `<span class="label">ctx:</span>\n${escapeHtml(formatJson(value))}`;
}
function clearTrace(el)        { if (el) el.innerHTML = ''; }
function showTraceEmpty(el)    { if (el) el.innerHTML = '<div class="empty">— no trace —</div>'; }
function showTraceRunning(el)  { if (el) el.innerHTML = '<div class="empty">…running…</div>'; }

function appendTraceRow(el, entry) {
  if (!el) return;
  const tag    = entry.errored ? 'xx' : 'ok';
  const tagTxt = entry.errored ? 'XX' : 'OK';
  const cycle  = entry.cycle > 1 ? ` <span class="dur">#${entry.cycle}</span>` : '';
  const out    = entry.errored
    ? `<span class="out fail">ERR</span>`
    : `<span class="out">${escapeHtml(entry.output)}</span>`;

  const indent = entry.depth ? '&nbsp;&nbsp;'.repeat(entry.depth) : '';
  const row = document.createElement('div');
  row.className = 'ln';
  row.innerHTML = `<span class="tag ${tag}">${tagTxt}</span>
    <span class="name">${indent}${escapeHtml(entry.step)}</span>${cycle}
    <span class="arrow">→</span>
    ${out}
    <span class="dur">${entry.duration.toFixed(2)}ms</span>`;
  el.appendChild(row);
  el.scrollTop = el.scrollHeight;
}

function renderResult(el, success, payload) {
  if (!el) return;
  el.classList.remove('fail');
  if (success) {
    el.innerHTML =
      `<span class="label">exit:</span> <span class="v">${escapeHtml(payload.exit)}</span>\n\n` +
      `<span class="label">ctx:</span>\n${escapeHtml(formatJson(payload.ctx))}`;
  } else {
    el.classList.add('fail');
    el.textContent =
      `${payload.name ?? 'RailError'}\n` +
      `  code:     ${payload.code ?? '—'}\n` +
      `  flowName: ${payload.flowName ?? '—'}\n` +
      (payload.cause
        ? `  cause:    ${payload.cause.name ?? '—'}: ${payload.cause.message ?? ''}`
        : '');
  }
}

/**
 * Converts a v0.3 trace (array of TraceEntry) into the legacy shape
 * the diagram playback expects. Filters out the outer-activity wrapper
 * entry (path === []) so each remaining row corresponds to a sub-node
 * the diagram can highlight.
 */
function adaptTrace(rawTrace) {
  return rawTrace
    .filter((e) => e.path.length > 0)
    .map((e) => ({
      step:     e.path.join('.'),
      output:   e.exit,
      errored:  e.exit === undefined && e.endTime === undefined,
      duration: (e.endTime ?? e.startTime) - e.startTime,
      depth:    e.path.length - 1,
      cycle:    e.cycle ?? 1,
      kind:     e.kind,
    }));
}

/**
 * Wires a demo section. Each section follows the same DOM convention:
 *   #<prefix>-diagram   .diagram-host
 *   #<prefix>-input     input ctx pane
 *   #<prefix>-trace     trace rows pane
 *   #<prefix>-result    result pane
 *   buttons:            within the section, `[data-scenario]`
 */
async function bootDemo({ prefix, graph, scenarios, runFn, diagramSteps, groupFn }) {
  const diagram = await createDiagram(`${prefix}-diagram`, graph, `svg-${prefix}`);
  if (!diagram) return;

  const elInput  = document.getElementById(`${prefix}-input`);
  const elTrace  = document.getElementById(`${prefix}-trace`);
  const elResult = document.getElementById(`${prefix}-result`);

  const sectionEl = elInput?.closest('section') ?? document;
  const buttons = sectionEl.querySelectorAll(`[data-scenario]`);

  async function runScenario(name) {
    const sc = scenarios[name];
    if (!sc) return;

    renderInput(elInput, sc.input);
    showTraceRunning(elTrace);
    if (elResult) { elResult.textContent = ''; elResult.classList.remove('fail'); }

    let adapted, exit, success = true, errored = false, payload;
    try {
      const r = await runFn(sc.input);
      adapted = adaptTrace(r.trace);
      exit = r.exit;
      payload = r;
    } catch (e) {
      success = false;
      errored = true;
      adapted = [];
      exit = null;
      payload = e;
    }

    clearTrace(elTrace);
    if (adapted.length === 0) showTraceEmpty(elTrace);

    const baseSteps = diagramSteps(adapted);
    const groupedSteps = (groupFn ?? groupTraceForDiagram)(adapted, baseSteps);

    await diagram.play(groupedSteps, {
      terminus: errored ? null : exit,
      onStepComplete: (i) => {
        for (const entry of groupedSteps[i].traceEntries) {
          appendTraceRow(elTrace, entry);
        }
      },
    });

    renderResult(elResult, success, payload);
  }

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      buttons.forEach((b) => { b.classList.add('ghost'); b.classList.remove('active'); });
      btn.classList.remove('ghost'); btn.classList.add('active');
      runScenario(btn.dataset.scenario);
    });
  });

  const first = buttons[0]?.dataset.scenario;
  if (first) runScenario(first);
}

/** Flat 1-level steps: each top-level sub-node is one diagram step. */
function flatSteps(adapted) {
  const out = [];
  for (const e of adapted) {
    if (e.depth !== 0) continue;
    out.push({ node: `n_${e.step}`, output: e.output, errored: e.errored, duration: e.duration });
  }
  return out;
}

/* ================================================================== */
/* 1. sendMessage (railway) — used in hero + the Railway live demo    */
/* ================================================================== */

class NetworkError extends Error {
  constructor(m) { super(m); this.name = 'NetworkError'; }
}

const sendMessage = railway((r) => {
  r.step('validate', async (ctx) => {
    await delay(4, 24);
    if (!ctx.roomId) throw new Error('roomId required');
    if (!ctx.body)   throw new Error('body required');
  });

  r.step('encrypt', async (ctx) => {
    await delay(35, 140);
    if (!ctx.keys) {
      const e = new Error('no keys provided'); e.name = 'NoKeysError'; throw e;
    }
    ctx.payload = `enc(${ctx.body})`;
  });

  r.step('send', async (ctx, _local, _runInfo) => {
    await delay(70, 280);
    if (ctx.willNetworkError) throw new NetworkError('5xx');
    if (ctx.willCrash)        throw new Error('unexpected database error');
    ctx.sent = true;
  });

  r.fail('report', async (ctx) => {
    await delay(5, 20);
    ctx.reported = ctx._error?.name ?? 'UnknownError';
  });
});

const SEND_MESSAGE_GRAPH = `flowchart LR
  start([success])
  n_validate["validate"]
  n_encrypt["encrypt"]
  n_send["send"]
  n_report["report"]
  endExit_success([success])
  endExit_failure([failure])
  start --> n_validate
  n_validate -- "success" --> n_encrypt
  n_validate -- "failure" --> n_report
  n_encrypt -- "success" --> n_send
  n_encrypt -- "failure" --> n_report
  n_send -- "success" --> endExit_success
  n_send -- "failure" --> n_report
  n_report -- "failure" --> endExit_failure`;

const sendMessageScenarios = {
  happy:    { input: { roomId: 'room-1', keys: 'k', body: 'Hello' } },
  validate: { input: { keys: 'k', body: 'no roomId' } },
  encrypt:  { input: { roomId: 'room-1', body: 'no keys provided' } },
  send:     { input: { roomId: 'room-1', keys: 'k', body: 'x', willNetworkError: true } },
};

/* Hero: synthesised steps (no real run; nice random-looking durations) */
const HERO_NODE_DUR = {
  n_validate: [4, 24],
  n_encrypt:  [35, 140],
  n_send:     [70, 280],
  n_report:   [5, 20],
};
function heroDur(id) {
  const [lo, hi] = HERO_NODE_DUR[id] ?? [40, 120];
  return rand(lo, hi);
}
function heroScenario(name) {
  switch (name) {
    case 'happy': return { steps: [
      { node: 'n_validate', output: 'success', duration: heroDur('n_validate') },
      { node: 'n_encrypt',  output: 'success', duration: heroDur('n_encrypt') },
      { node: 'n_send',     output: 'success', duration: heroDur('n_send') },
    ], terminus: 'success' };
    case 'validate': return { steps: [
      { node: 'n_validate', output: 'failure', duration: heroDur('n_validate') },
      { node: 'n_report',   output: 'failure', duration: heroDur('n_report') },
    ], terminus: 'failure' };
    case 'encrypt': return { steps: [
      { node: 'n_validate', output: 'success', duration: heroDur('n_validate') },
      { node: 'n_encrypt',  output: 'failure', duration: heroDur('n_encrypt') },
      { node: 'n_report',   output: 'failure', duration: heroDur('n_report') },
    ], terminus: 'failure' };
    case 'send': return { steps: [
      { node: 'n_validate', output: 'success', duration: heroDur('n_validate') },
      { node: 'n_encrypt',  output: 'success', duration: heroDur('n_encrypt') },
      { node: 'n_send',     output: 'failure', duration: heroDur('n_send') },
      { node: 'n_report',   output: 'failure', duration: heroDur('n_report') },
    ], terminus: 'failure' };
  }
}

async function setupHero() {
  const diagram = await createDiagram('hero-diagram', SEND_MESSAGE_GRAPH, 'svg-hero');
  if (!diagram) return;

  const buttons = document.querySelectorAll('[data-hero]');
  let interacted = false;

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      interacted = true;
      buttons.forEach((b) => { b.classList.add('ghost'); b.classList.remove('active'); });
      btn.classList.remove('ghost'); btn.classList.add('active');
      const sc = heroScenario(btn.dataset.hero);
      diagram.play(sc.steps, { terminus: sc.terminus });
    });
  });

  (async () => {
    const order = ['happy', 'validate', 'encrypt', 'send'];
    let i = 0;
    while (!interacted) {
      const name = order[i % order.length];
      buttons.forEach((b) => { b.classList.add('ghost'); b.classList.remove('active'); });
      document.querySelector(`[data-hero="${name}"]`)?.classList.replace('ghost', 'active');
      const sc = heroScenario(name);
      await diagram.play(sc.steps, { terminus: sc.terminus });
      if (interacted) break;
      await sleep(1400);
      i++;
    }
  })();
}

const sendMessageFlow = flow('sendMessage', sendMessage);

async function setupRailwayDemo() {
  await bootDemo({
    prefix: 'rwy',
    graph: SEND_MESSAGE_GRAPH,
    scenarios: sendMessageScenarios,
    runFn: (input) => sendMessageFlow.run(input, { logger: noLog }),
    diagramSteps: flatSteps,
  });
}

/* ================================================================== */
/* 2. n-Rail: multi-track + retry loop via label/link                 */
/* ================================================================== */

/*
 * The order pipeline combines two n-Rail-specific patterns:
 *   1. Per-rail convergence at `cleanup.fail` — every upstream `fail`
 *      output (`validate`, `shouldRetry`) wires automatically into
 *      the cleanup step.
 *   2. A retry loop expressed as a label + link: `r.label('charge', 'main')`
 *      anchors a point in the main rail, and `r.link('charge', 'retry')`
 *      sends the retry rail back to that anchor. The loop spans three
 *      nodes — chargeAttempt → shouldRetry → charge → chargeAttempt —
 *      and the per-position `local.retries` bounds it.
 */
const orderPipeline = nrail((r) => {
  r.entry('main');

  r.step('validate',
    catchTo(async (ctx) => {
      await delay(8, 24);
      if (!ctx.orderId) throw new Error('missing orderId');
      return 'main';
    }, 'fail'),
    'main', ['main', 'fail']);

  r.label('charge', 'main');           // ← retry anchor

  r.step('chargeAttempt',
    catchTo(async (ctx) => {
      await delay(30, 90);
      const attempt = (ctx.attempt ?? 0) + 1;
      ctx.attempt = attempt;
      if (ctx.failOn?.includes(attempt)) {
        throw new Error(`transient failure on attempt ${attempt}`);
      }
      ctx.tx = `tx-${ctx.orderId}-${attempt}`;
      return 'main';
    }, 'retry'),
    'main', ['main', 'retry']);

  r.step('shouldRetry', async (ctx, local) => {
    await delay(5, 15);
    local.retries = (local.retries ?? 0) + 1;
    ctx.retries = local.retries;
    return local.retries >= (ctx.maxRetries ?? 3) ? 'fail' : 'retry';
  }, 'retry', ['retry', 'fail']);

  r.link('charge', 'retry');           // ← back-edge to the label

  r.step('cleanup', async (ctx) => {
    await delay(8, 20);
    ctx.cleanedUp = true;
  }, 'fail', 'fail');
});

const ORDER_PIPELINE_GRAPH = `flowchart LR
  start([main])
  n_validate["validate"]
  n_charge["charge<br/><span style='font-size: 10px; color: #6b635a'>(label)</span>"]
  n_chargeAttempt["chargeAttempt"]
  n_shouldRetry["shouldRetry<br/><span style='font-size: 10px; color: #6b635a'>local.retries</span>"]
  n_cleanup["cleanup"]
  endExit_main([main])
  endExit_fail([fail])
  start --> n_validate
  n_validate -- "main" --> n_chargeAttempt
  n_validate -- "fail" --> n_cleanup
  n_charge -- "main" --> n_chargeAttempt
  n_chargeAttempt -- "main" --> endExit_main
  n_chargeAttempt -- "retry" --> n_shouldRetry
  n_shouldRetry -- "retry" --> n_charge
  n_shouldRetry -- "fail" --> n_cleanup
  n_cleanup -- "fail" --> endExit_fail`;

const orderScenarios = {
  happy:       { input: { orderId: '42' } },
  oneRetry:    { input: { orderId: '42', failOn: [1] } },
  exhausted:   { input: { orderId: '42', failOn: [1, 2, 3, 4], maxRetries: 3 } },
  missing:     { input: {} },
};

const orderFlow = flow('orderPipeline', orderPipeline);

async function setupNrailDemo() {
  await bootDemo({
    prefix: 'nrl',
    graph: ORDER_PIPELINE_GRAPH,
    scenarios: orderScenarios,
    runFn: (input) => orderFlow.run(input, { logger: noLog }),
    diagramSteps: (adapted) => adapted
      .filter((e) => e.depth === 0)
      .map((e) => ({
        node: `n_${e.step}`,
        output: e.output,
        errored: e.errored,
        duration: e.duration,
      })),
  });
}

/* ================================================================== */
/* 3. Activity: approval workflow with a multi-node cycle             */
/* ================================================================== */

/*
 * A topology that doesn't fit a linear rail: `revise.ok` wires back
 * to `review.in`, forming a cycle through three nodes (review →
 * revise → review). `review.in` converges two sources (the entry
 * via `submit` on the first pass, and `revise` on subsequent
 * iterations). n-Rail can express this with a label + link on
 * `review`; activity wires it as a direct backward edge instead.
 */
const submit = atom(async (ctx) => {
  await delay(10, 24);
  ctx.submitted = true;
  return 'ok';
}, { outputs: ['ok'] });

const review = atom(async (ctx, local) => {
  await delay(20, 60);
  local.reviews = (local.reviews ?? 0) + 1;
  const verdict = ctx.verdicts?.[local.reviews - 1] ?? 'approve';
  ctx.lastVerdict = verdict;
  ctx.reviews = local.reviews;
  return verdict;
}, { outputs: ['approve', 'reject', 'changes'] });

const revise = atom(async (ctx, local) => {
  await delay(15, 40);
  local.revisions = (local.revisions ?? 0) + 1;
  ctx.revisions = local.revisions;
  return 'ok';
}, { outputs: ['ok'] });

const publish = atom(async (ctx) => {
  await delay(25, 70);
  ctx.published = true;
  return 'ok';
}, { outputs: ['ok'] });

const approval = activity((a) => {
  a.entry('in');
  a.addNode('submit',  submit);
  a.addNode('review',  review);
  a.addNode('revise',  revise);
  a.addNode('publish', publish);
  a.exit('done');
  a.exit('rejected');

  a.wire('.in',             'submit.in');
  a.wire('submit.ok',       'review.in');
  a.wire('review.approve',  'publish.in');
  a.wire('review.changes',  'revise.in');
  a.wire('review.reject',   '.rejected');
  a.wire('revise.ok',       'review.in');   // ← multi-node cycle
  a.wire('publish.ok',      '.done');
});

const APPROVAL_GRAPH = `flowchart LR
  start([in])
  n_submit["submit"]
  n_review["review<br/><span style='font-size: 10px; color: #6b635a'>local.reviews</span>"]
  n_revise["revise"]
  n_publish["publish"]
  endExit_done([done])
  endExit_rejected([rejected])
  start --> n_submit
  n_submit -- "ok" --> n_review
  n_review -- "approve" --> n_publish
  n_review -- "changes" --> n_revise
  n_review -- "reject"  --> endExit_rejected
  n_revise -- "ok" --> n_review
  n_publish -- "ok" --> endExit_done`;

const approvalScenarios = {
  approved:    { input: { verdicts: ['approve'] } },
  oneRevision: { input: { verdicts: ['changes', 'approve'] } },
  rejected:    { input: { verdicts: ['reject'] } },
  twoRevisions:{ input: { verdicts: ['changes', 'changes', 'approve'] } },
};

const approvalFlow = flow('approval', approval);

async function setupActivityDemo() {
  await bootDemo({
    prefix: 'act',
    graph: APPROVAL_GRAPH,
    scenarios: approvalScenarios,
    runFn: (input) => approvalFlow.run(input, { logger: noLog }),
    // Each top-level trace entry is its own diagram step — the
    // animation steps through every cycle iteration of review/revise.
    diagramSteps: (adapted) => adapted
      .filter((e) => e.depth === 0)
      .map((e) => ({
        node: `n_${e.step}`,
        output: e.output,
        errored: e.errored,
        duration: e.duration,
      })),
  });
}

/* ================================================================== */
/* 4. Parallel + merge                                                */
/* ================================================================== */

const fetchProfile = step(async (ctx) => {
  await delay(80, 240);
  if (ctx.profileFails) throw new Error('profile lookup failed');
  ctx.profile = { id: ctx.userId, name: 'Markus' };
});

const fetchOrders = step(async (ctx) => {
  await delay(120, 320);
  ctx.orders = ['order-A', 'order-B'];
});

const mergeResults = atom(async (ctx) => {
  await delay(5, 20);
  // Aggregated ctx is { profile: <branchCtx>, orders: <branchCtx> }.
  // Each branch has an _error field on failure (via step's catchTo).
  if (ctx.profile._error || ctx.orders._error) {
    const ranInto = ctx.profile._error ? 'profile' : 'orders';
    for (const k of Object.keys(ctx)) delete ctx[k];
    ctx.failed = ranInto;
    return 'failed';
  }
  const userId  = ctx.profile.userId;
  const profile = ctx.profile.profile;
  const orders  = ctx.orders.orders;
  for (const k of Object.keys(ctx)) delete ctx[k];
  ctx.userId  = userId;
  ctx.profile = profile;
  ctx.orders  = orders;
  return 'ok';
}, { outputs: ['ok', 'failed'] });

const enrich = parallel({
  profile: fetchProfile,
  orders:  fetchOrders,
}, mergeResults);

const PARALLEL_GRAPH = `flowchart LR
  start([in])
  n_fan{{"fan: profile · orders → merge"}}
  endExit_ok([ok])
  endExit_failed([failed])
  start --> n_fan
  n_fan -- "ok" --> endExit_ok
  n_fan -- "failed" --> endExit_failed`;

const parScenarios = {
  both:         { input: { userId: 1 } },
  profileFails: { input: { userId: 1, profileFails: true } },
};

const enrichFlow = flow('enrich', enrich);

async function setupParallelDemo() {
  await bootDemo({
    prefix: 'par',
    graph: PARALLEL_GRAPH,
    scenarios: parScenarios,
    runFn: (input) => enrichFlow.run(input, { logger: noLog }),
    diagramSteps: () => [{ node: 'n_fan', duration: 250 }],
    // The parallel composite is one diagram step; all branch + merge
    // trace entries belong to it. The merge entry determines the exit.
    groupFn: (adapted, steps) => {
      const merge = adapted.find((e) => e.step === '__merge__');
      return [{
        ...steps[0],
        output:   merge?.output,
        errored:  !merge || merge.errored,
        duration: merge?.duration ?? 250,
        traceEntries: adapted,
      }];
    },
  });
}

/* ================================================================== */
/* Boot all demos                                                     */
/* ================================================================== */

await setupHero();
await setupRailwayDemo();
await setupNrailDemo();
await setupActivityDemo();
await setupParallelDemo();

/* ================================================================== */
/* Source-code panels                                                 */
/* ================================================================== */

const SRC_RAILWAY = `import { railway, flow } from '@isnogudus/rail.js';

const sendMessage = railway((r) => {
  r.step('validate', async (ctx) => {
    if (!ctx.roomId) throw new Error('roomId required');
    if (!ctx.body)   throw new Error('body required');
  });

  r.step('encrypt', async (ctx) => {
    if (!ctx.keys) {
      const e = new Error('no keys'); e.name = 'NoKeysError'; throw e;
    }
    ctx.payload = await encrypt(ctx.body);
  });

  r.step('send', async (ctx, _local, runInfo) => {
    await fetch(ctx.url, { body: ctx.payload, signal: runInfo.signal });
  });

  r.fail('report', async (ctx) => {
    // The original throw is on ctx._error (set by catchTo).
    log.error(ctx._error);
  });
});

const r = await flow('sendMessage', sendMessage).run(ctx);
//   r.exit  → 'success' | 'failure'
//   r.ctx   → final running ctx (mutated in place)
//   r.trace → ordered TraceEntry[]
`;

const SRC_NRAIL = `import { nrail, catchTo, flow } from '@isnogudus/rail.js';

const orderPipeline = nrail((r) => {
  r.entry('main');

  r.step('validate',
    catchTo(async (ctx) => {
      if (!ctx.orderId) throw new Error('missing orderId');
      return 'main';
    }, 'fail'),
    'main', ['main', 'fail']);

  // Anchor a point in the 'main' rail. The label produces a Live-Set
  // entry on 'main' that the next consumer (chargeAttempt) will
  // converge with validate.main.
  r.label('charge', 'main');

  r.step('chargeAttempt',
    catchTo(async (ctx) => {
      ctx.tx = await charge(ctx);
      return 'main';
    }, 'retry'),
    'main', ['main', 'retry']);

  r.step('shouldRetry', async (ctx, local) => {
    local.retries = (local.retries ?? 0) + 1;
    return local.retries >= ctx.maxRetries ? 'fail' : 'retry';
  }, 'retry', ['retry', 'fail']);

  // Send the 'retry' rail back to the 'charge' label's input —
  // a multi-node loop expressed declaratively.
  r.link('charge', 'retry');

  r.step('cleanup', async (ctx) => {
    await rollback(ctx);
  }, 'fail', 'fail');
});

// outputs === ['main', 'fail']. Two n-Rail features at play:
//   - per-rail convergence: every upstream 'fail' wires into cleanup.fail
//   - label/link loop: chargeAttempt.retry → shouldRetry → charge.in
//                      → chargeAttempt.main (via convergence on 'main')
`;

const SRC_ACTIVITY = `import { activity, atom, flow } from '@isnogudus/rail.js';

const review = atom(async (ctx, local) => {
  local.reviews = (local.reviews ?? 0) + 1;
  const verdict = ctx.verdicts?.[local.reviews - 1] ?? 'approve';
  ctx.lastVerdict = verdict;
  return verdict;                          // 'approve' | 'reject' | 'changes'
}, { outputs: ['approve', 'reject', 'changes'] });

const approval = activity((a) => {
  a.entry('in');
  a.addNode('submit',  submit);
  a.addNode('review',  review);
  a.addNode('revise',  revise);
  a.addNode('publish', publish);
  a.exit('done');
  a.exit('rejected');

  // Wires are string references: 'name.port' or '.port' (the empty
  // node name refers to the activity itself). Note: 'review.in'
  // converges from two sources, and 'revise.ok' wires backward —
  // a multi-node cycle (review → revise → review). n-Rail expresses
  // the same topology with a label on 'review' and a link from the
  // 'changes' rail; activity writes the backward edge directly.
  a.wire('.in',             'submit.in');
  a.wire('submit.ok',       'review.in');
  a.wire('review.approve',  'publish.in');
  a.wire('review.changes',  'revise.in');
  a.wire('review.reject',   '.rejected');
  a.wire('revise.ok',       'review.in');   // ← backward edge
  a.wire('publish.ok',      '.done');
});
`;

const SRC_PARALLEL = `import { activity, parallel, atom, step, flow } from '@isnogudus/rail.js';

const fetchProfile = step(async (ctx) => {
  ctx.profile = await api.profile(ctx.userId);
});

const fetchOrders = step(async (ctx) => {
  ctx.orders = await api.orders(ctx.userId);
});

const mergeResults = atom(async (ctx) => {
  // Aggregated ctx is { profile: <branchCtx>, orders: <branchCtx> }.
  // Each branch's _error is set by step's catchTo on caught throws.
  if (ctx.profile._error || ctx.orders._error) {
    const ranInto = ctx.profile._error ? 'profile' : 'orders';
    for (const k of Object.keys(ctx)) delete ctx[k];
    ctx.failed = ranInto;
    return 'failed';
  }
  const userId  = ctx.profile.userId;
  const profile = ctx.profile.profile;
  const orders  = ctx.orders.orders;
  for (const k of Object.keys(ctx)) delete ctx[k];
  ctx.userId = userId;
  ctx.profile = profile;
  ctx.orders = orders;
  return 'ok';
}, { outputs: ['ok', 'failed'] });

const enrich = parallel({
  profile: fetchProfile,
  orders:  fetchOrders,
}, mergeResults);
// enrich.outputs === ['ok', 'failed'] — the merge node's outputs.
`;

const SOURCES = {
  'rwy-source':  SRC_RAILWAY,
  'nrl-source':  SRC_NRAIL,
  'act-source':  SRC_ACTIVITY,
  'par-source':  SRC_PARALLEL,
};

for (const [id, src] of Object.entries(SOURCES)) {
  const el = document.getElementById(id);
  if (el) el.textContent = src.trim() + '\n';
}

/* ================================================================== */
/* Tab wiring                                                         */
/* ================================================================== */

for (const tabsEl of document.querySelectorAll('.stage .tabs')) {
  const stageEl = tabsEl.closest('.stage');
  if (!stageEl) continue;
  const buttons = tabsEl.querySelectorAll('.tab');
  const panels  = stageEl.querySelectorAll('.tab-panel');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      buttons.forEach((b) => b.classList.toggle('active', b === btn));
      panels.forEach((p) => p.classList.toggle('active', p.dataset.tab === target));
    });
  });
}
