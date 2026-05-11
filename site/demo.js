/**
 * Live demos. Each example bootstraps:
 *
 *   1. A checked rail.js activity (or any Rail-Node).
 *   2. A Mermaid graph definition rendered into the section's
 *      `.diagram-host` element via `createDiagram`.
 *   3. Scenario buttons that, on click, run the activity and animate
 *      the resulting trace through the diagram. Trace rows are
 *      revealed iteratively in sync with the diagram playback.
 *
 * Shared helpers at the top; one `setup<Name>()` per example.
 */

import {
  activity,
  node,
  catching,
  parallel,
  flow,
  exceptionCtx,
  isExceptionCtx,
  isParallelCtx,
} from '@isnogudus/rail.js';

import { createDiagram, groupTraceForDiagram } from './diagrams.js';

/* ================================================================== */
/* Shared helpers                                                     */
/* ================================================================== */

function rand(min, max) { return min + Math.random() * (max - min); }
function delay(min, max) { return new Promise((r) => setTimeout(r, rand(min, max))); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function formatJson(value) { return JSON.stringify(value, null, 2); }

function renderInput(el, value) {
  if (!el) return;
  el.innerHTML = `<span class="label">ctx:</span>\n${escapeHtml(formatJson(value))}`;
}

function clearTrace(el) {
  if (!el) return;
  el.innerHTML = '';
}

function showTraceEmpty(el) {
  if (!el) return;
  el.innerHTML = '<div class="empty">— no trace —</div>';
}

function showTraceRunning(el) {
  if (!el) return;
  el.innerHTML = '<div class="empty">…running…</div>';
}

function appendTraceRow(el, entry) {
  if (!el) return;
  const tag    = entry.threw ? 'xx' : 'ok';
  const tagTxt = entry.threw ? 'XX' : 'OK';
  const out    = entry.threw
    ? `<span class="out fail">${escapeHtml(entry.error?.code ?? entry.error?.name ?? 'ERR')}</span>`
    : `<span class="out">${escapeHtml(entry.output)}</span>`;

  const indent = entry.depth ? '&nbsp;&nbsp;'.repeat(entry.depth) : '';
  const row = document.createElement('div');
  row.className = 'ln';
  row.innerHTML = `<span class="tag ${tag}">${tagTxt}</span>
    <span class="name">${indent}${escapeHtml(entry.step)}</span>
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
      `<span class="label">terminus:</span> <span class="v">${escapeHtml(payload.terminus)}</span>\n\n` +
      `<span class="label">ctx:</span>\n${escapeHtml(formatJson(payload.ctx))}`;
  } else {
    el.classList.add('fail');
    el.textContent =
      `RailRuntimeError\n` +
      `  code:  ${payload.code}\n` +
      `  cause: ${payload.cause?.name ?? '—'}: ${payload.cause?.message ?? ''}`;
  }
}

/**
 * Wires a demo section. Each section follows the same DOM convention:
 *   #<prefix>-diagram   .diagram-host
 *   #<prefix>-input     input ctx pane
 *   #<prefix>-trace     trace rows pane
 *   #<prefix>-result    result pane
 *   buttons:            within the section, `[data-scenario]`
 *
 * `runFn(input)` returns a Promise of `{ trace, terminus, ctx }`.
 * `mapSteps(trace)` turns a real trace into an array of diagram steps;
 * default groups by node-name (good for plain activities; sub-activity
 * and parallel use this same default thanks to groupTraceForDiagram).
 */
async function bootDemo({
  prefix,
  graph,
  scenarios,
  runFn,
  diagramSteps,  // function: (trace) → Array of { node, output?, errored?, duration? }
}) {
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

    let trace, terminus, success = true, errored = false, payload;
    try {
      const r = await runFn(sc.input);
      trace = r.trace;
      terminus = r.terminus;
      payload = r;
    } catch (e) {
      success = false;
      errored = true;
      trace = e.trace ?? [];
      terminus = null;
      payload = e;
    }

    clearTrace(elTrace);
    if (trace.length === 0) showTraceEmpty(elTrace);

    // Build diagram steps with trace-entry groups.
    const baseSteps = diagramSteps(trace);
    const groupedSteps = groupTraceForDiagram(trace, baseSteps);

    await diagram.play(groupedSteps, {
      terminus: errored ? null : terminus,
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

  // Initial: first scenario.
  const first = buttons[0]?.dataset.scenario;
  if (first) runScenario(first);
}

/* ================================================================== */
/* 1. sendMessage (hero + live demo)                                  */
/* ================================================================== */

class NetworkError extends Error {
  constructor(message) { super(message); this.name = 'NetworkError'; }
}

const sendMessage = activity((a) => {
  const start = a.entry('in');
  const { success, failure } = a.standardExits();

  const validate = a.addNode('validate', node(async (ctx) => {
    await delay(4, 24);
    if (!ctx.roomId) return 'invalid';
    return { output: 'ok', ctx: { ...ctx, validated: true } };
  }, { outputs: ['ok', 'invalid'] }));

  const encrypt = a.addNode('encrypt', node(async (ctx) => {
    await delay(35, 140);
    if (!ctx.keys) return 'noKeys';
    return { output: 'ok', ctx: { ...ctx, encrypted: true } };
  }, { outputs: ['ok', 'noKeys'] }));

  const send = a.addNode('send', catching(
    node(async (ctx) => {
      await delay(70, 280);
      if (ctx.willNetworkError) throw new NetworkError('5xx');
      if (ctx.willCrash)        throw new Error('unexpected database error');
      return 'ok';
    }, { outputs: ['ok'] }),
    { NetworkError: 'net5xx' }
  ));

  a.wire(start,                   validate);
  a.wire(validate.out('ok'),      encrypt);
  a.wire(validate.out('invalid'), failure);
  a.wire(encrypt.out('ok'),       send);
  a.wire(encrypt.out('noKeys'),   failure);
  a.wire(send.out('ok'),          success);
  a.wire(send.out('net5xx'),      failure);
});
sendMessage.check();

const SEND_MESSAGE_GRAPH = `flowchart LR
  start([in])
  n_validate["validate"]
  n_encrypt["encrypt"]
  n_send["send"]
  endExit_success([ok])
  endExit_failure([fail])
  start --> n_validate
  n_validate -- "ok" --> n_encrypt
  n_validate -- "invalid" --> endExit_failure
  n_encrypt -- "ok" --> n_send
  n_encrypt -- "noKeys" --> endExit_failure
  n_send -- "ok" --> endExit_success
  n_send -- "net5xx" --> endExit_failure`;

const sendMessageScenarios = {
  happy:    { input: { roomId: 'room-1', keys: 'k', body: 'Hello' } },
  invalid:  { input: { keys: 'k', body: 'no roomId' } },
  noKeys:   { input: { roomId: 'room-1', body: 'no keys provided' } },
  net5xx:   { input: { roomId: 'room-1', keys: 'k', body: 'x', willNetworkError: true } },
  throws:   { input: { roomId: 'room-1', keys: 'k', body: 'x', willCrash: true } },
};

// Hero scenario synthesiser (no real run; just nice random-looking steps)
const HERO_NODE_DUR = {
  n_validate: [4, 24],
  n_encrypt:  [35, 140],
  n_send:     [70, 280],
};
function heroDur(id) {
  const [lo, hi] = HERO_NODE_DUR[id] ?? [40, 120];
  return rand(lo, hi);
}
function heroScenario(name) {
  switch (name) {
    case 'happy':   return { steps: [
      { node: 'n_validate', output: 'ok', duration: heroDur('n_validate') },
      { node: 'n_encrypt',  output: 'ok', duration: heroDur('n_encrypt') },
      { node: 'n_send',     output: 'ok', duration: heroDur('n_send') },
    ], terminus: 'success' };
    case 'invalid': return { steps: [
      { node: 'n_validate', output: 'invalid', duration: heroDur('n_validate') },
    ], terminus: 'failure' };
    case 'noKeys':  return { steps: [
      { node: 'n_validate', output: 'ok',     duration: heroDur('n_validate') },
      { node: 'n_encrypt',  output: 'noKeys', duration: heroDur('n_encrypt') },
    ], terminus: 'failure' };
    case 'net5xx':  return { steps: [
      { node: 'n_validate', output: 'ok',     duration: heroDur('n_validate') },
      { node: 'n_encrypt',  output: 'ok',     duration: heroDur('n_encrypt') },
      { node: 'n_send',     output: 'net5xx', duration: heroDur('n_send') },
    ], terminus: 'failure' };
    case 'throws':  return { steps: [
      { node: 'n_validate', output: 'ok', duration: heroDur('n_validate') },
      { node: 'n_encrypt',  output: 'ok', duration: heroDur('n_encrypt') },
      { node: 'n_send',     errored: true, duration: heroDur('n_send') },
    ], terminus: null };
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
    const order = ['happy', 'invalid', 'noKeys', 'net5xx', 'throws'];
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

// Live sendMessage demo
const sendMessageFlow = flow('sendMessage', sendMessage);

async function setupSendMessageDemo() {
  // The existing demo uses prefix 'demo' (legacy from earlier wiring).
  // Map button[data-demo=…] to data-scenario semantics.
  const diagram = await createDiagram('demo-diagram', SEND_MESSAGE_GRAPH, 'svg-demo');
  if (!diagram) return;

  const elInput  = document.getElementById('demo-input');
  const elTrace  = document.getElementById('demo-trace');
  const elResult = document.getElementById('demo-result');
  const buttons  = document.querySelectorAll('[data-demo]');

  async function runScenario(name) {
    const sc = sendMessageScenarios[name];
    if (!sc) return;
    renderInput(elInput, sc.input);
    showTraceRunning(elTrace);
    elResult.textContent = '';
    elResult.classList.remove('fail');

    let trace, terminus, success = true, errored = false, payload;
    try {
      const r = await sendMessageFlow.run(sc.input, { logger: () => {} });
      trace = r.trace; terminus = r.terminus; payload = r;
    } catch (e) {
      success = false; errored = true; trace = e.trace ?? []; terminus = null; payload = e;
    }

    clearTrace(elTrace);
    if (trace.length === 0) showTraceEmpty(elTrace);

    const baseSteps = trace.map((e) => ({
      node: `n_${e.step}`,
      output: e.output ?? undefined,
      errored: e.threw,
      duration: e.duration,
    }));
    const groupedSteps = groupTraceForDiagram(trace, baseSteps);

    await diagram.play(groupedSteps, {
      terminus: errored ? null : terminus,
      onStepComplete: (i) => {
        for (const entry of groupedSteps[i].traceEntries) appendTraceRow(elTrace, entry);
      },
    });
    renderResult(elResult, success, payload);
  }

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      buttons.forEach((b) => { b.classList.add('ghost'); b.classList.remove('active'); });
      btn.classList.remove('ghost'); btn.classList.add('active');
      runScenario(btn.dataset.demo);
    });
  });
  runScenario('happy');
}

/* ================================================================== */
/* 2. Sub-activity composition                                        */
/* ================================================================== */

const innerActivity = activity((a) => {
  const start = a.entry('in');
  const { success, failure } = a.standardExits();

  const encrypt = a.addNode('encrypt', node(async (ctx) => {
    await delay(30, 120);
    if (!ctx.keys) return 'noKeys';
    return { output: 'ok', ctx: { ...ctx, encrypted: true } };
  }, { outputs: ['ok', 'noKeys'] }));
  const send = a.addNode('send', node(async (ctx) => {
    await delay(60, 220);
    return { output: 'ok', ctx: { ...ctx, sent: true } };
  }, { outputs: ['ok'] }));

  a.wire(start,                 encrypt);
  a.wire(encrypt.out('ok'),     send);
  a.wire(encrypt.out('noKeys'), failure);
  a.wire(send.out('ok'),        success);
});

const outerActivity = activity((a) => {
  const start = a.entry('in');
  const { success, failure } = a.standardExits();

  const preflight = a.addNode('preflight', node(async (ctx) => {
    await delay(5, 25);
    return ctx.skip ? 'skip' : 'ok';
  }, { outputs: ['ok', 'skip'] }));
  const wrapped = a.addNode('inner', innerActivity);

  a.wire(start,                  preflight);
  a.wire(preflight.out('ok'),    wrapped);
  a.wire(preflight.out('skip'),  success);
  a.wire(wrapped.out('success'), success);
  a.wire(wrapped.out('failure'), failure);
});
outerActivity.check();

const SUB_GRAPH = `flowchart LR
  start([in])
  n_preflight["preflight"]
  n_inner[[inner]]
  endExit_success([success])
  endExit_failure([failure])
  start --> n_preflight
  n_preflight -- "ok" --> n_inner
  n_preflight -- "skip" --> endExit_success
  n_inner -- "success" --> endExit_success
  n_inner -- "failure" --> endExit_failure`;

const subScenarios = {
  happy:  { input: { keys: 'k' } },
  skip:   { input: { skip: true } },
  noKeys: { input: {} },
};

const outerFlow = flow('outer', outerActivity);

async function setupSubDemo() {
  await bootDemo({
    prefix: 'sub',
    graph: SUB_GRAPH,
    scenarios: subScenarios,
    runFn: (input) => outerFlow.run(input, { logger: () => {} }),
    // Direct children of the outer activity: depth=0 and no dot in the
    // step name. (Dotted names like 'inner.encrypt' are inner-of-inner.)
    diagramSteps: (trace) => directOuterSteps(trace),
  });
}

/** Picks the unique direct children of the outermost activity. */
function directOuterSteps(trace) {
  const seen = new Set();
  const out = [];
  for (const e of trace) {
    if (e.depth !== 0 || e.step.includes('.')) continue;
    if (seen.has(e.step)) continue;
    seen.add(e.step);
    out.push({ node: `n_${e.step}`, output: e.output, errored: e.threw, duration: e.duration });
  }
  return out;
}

/* ================================================================== */
/* 3. Parallel + evaluate                                             */
/* ================================================================== */

const profileBranch = activity((a) => {
  const start = a.entry('in');
  const { success, failure } = a.standardExits();
  const fetch = a.addNode('fetch', node(async (ctx) => {
    await delay(80, 240);
    if (ctx.profileFails) return 'failure';
    return { output: 'success', ctx: { ...ctx, profile: { id: ctx.userId, name: 'Markus' } } };
  }, { outputs: ['success', 'failure'] }));
  a.wire(start, fetch);
  a.wire(fetch.out('success'), success);
  a.wire(fetch.out('failure'), failure);
});

const keysBranch = activity((a) => {
  const start = a.entry('in');
  const { success, failure } = a.standardExits();
  const fetch = a.addNode('fetch', node(async (ctx) => {
    await delay(120, 320);
    return { output: 'success', ctx: { ...ctx, keys: ['k-1', 'k-2'] } };
  }, { outputs: ['success', 'failure'] }));
  a.wire(start, fetch);
  a.wire(fetch.out('success'), success);
  a.wire(fetch.out('failure'), failure);
});

const parallelActivity = activity((a) => {
  const start = a.entry('in');
  const ok = a.exit('ok');
  const failed = a.exit('failed');

  const fan = a.addNode('fan', parallel({
    profile: profileBranch,
    keys:    keysBranch,
  }));
  const evaluate = a.addNode('evaluate', node(async (ctx) => {
    await delay(5, 25);
    if (!isParallelCtx(ctx)) return 'failed';
    const { inputCtx, results } = ctx;
    if (results.profile.terminus !== 'success' || results.keys.terminus !== 'success') {
      return { output: 'failed', ctx: { ...inputCtx, errored: true } };
    }
    return {
      output: 'ok',
      ctx: { ...inputCtx, profile: results.profile.ctx.profile, keys: results.keys.ctx.keys },
    };
  }, { outputs: ['ok', 'failed'] }));

  a.wire(start,                  fan);
  a.wire(fan.out('done'),        evaluate);
  a.wire(evaluate.out('ok'),     ok);
  a.wire(evaluate.out('failed'), failed);
});
parallelActivity.check();

const PAR_GRAPH = `flowchart LR
  start([in])
  n_fan{{fan}}
  n_evaluate["evaluate"]
  endExit_ok([ok])
  endExit_failed([failed])
  start --> n_fan
  n_fan -- "done" --> n_evaluate
  n_evaluate -- "ok" --> endExit_ok
  n_evaluate -- "failed" --> endExit_failed`;

const parScenarios = {
  both:    { input: { userId: 1 } },
  failure: { input: { userId: 1, profileFails: true } },
};

const parallelFlow = flow('loadProfileAndKeys', parallelActivity);

async function setupParallelDemo() {
  await bootDemo({
    prefix: 'par',
    graph: PAR_GRAPH,
    scenarios: parScenarios,
    runFn: (input) => parallelFlow.run(input, { logger: () => {} }),
    // Only the parallel-node ('fan') and the post-evaluator ('evaluate').
    // groupTraceForDiagram absorbs the branch compounds and inner branch
    // steps into the 'fan' step's traceEntries.
    diagramSteps: (trace) => directOuterSteps(trace),
  });
}

/* ================================================================== */
/* 4. exceptionCtx + recover                                          */
/* ================================================================== */

const robustActivity = activity((a) => {
  const start = a.entry('in');
  const { success, failure } = a.standardExits();

  const op = a.addNode('op', node(async (ctx) => {
    await delay(40, 160);
    try {
      if (ctx.kind === 'timeout') {
        const e = new Error('timed out');  e.name = 'TimeoutError'; throw e;
      }
      if (ctx.kind === 'fatal') {
        const e = new Error('boom');       e.name = 'FatalError';   throw e;
      }
      return { output: 'ok', ctx: { ...ctx, result: 42 } };
    } catch (e) {
      return { output: 'failed', ctx: exceptionCtx(e, ctx) };
    }
  }, { outputs: ['ok', 'failed'] }));

  const recover = a.addNode('recover', node(async (ctx) => {
    await delay(15, 60);
    if (!isExceptionCtx(ctx)) return { output: 'fatal', ctx };
    const { inputCtx, error } = ctx;
    if (error.name === 'TimeoutError') {
      return { output: 'ok', ctx: { ...inputCtx, retried: true } };
    }
    return { output: 'fatal', ctx: { ...inputCtx, lastError: error.name } };
  }, { outputs: ['ok', 'fatal'] }));

  a.wire(start,                op);
  a.wire(op.out('ok'),         success);
  a.wire(op.out('failed'),     recover);
  a.wire(recover.out('ok'),    success);
  a.wire(recover.out('fatal'), failure);
});
robustActivity.check();

const EXC_GRAPH = `flowchart LR
  start([in])
  n_op["op"]
  n_recover["recover"]
  endExit_success([success])
  endExit_failure([failure])
  start --> n_op
  n_op -- "ok" --> endExit_success
  n_op -- "failed" --> n_recover
  n_recover -- "ok" --> endExit_success
  n_recover -- "fatal" --> endExit_failure`;

const excScenarios = {
  happy:        { input: { kind: 'ok' } },
  recoverable:  { input: { kind: 'timeout' } },
  fatal:        { input: { kind: 'fatal' } },
};

const robustFlow = flow('robust', robustActivity);

async function setupExceptionDemo() {
  await bootDemo({
    prefix: 'exc',
    graph: EXC_GRAPH,
    scenarios: excScenarios,
    runFn: (input) => robustFlow.run(input, { logger: () => {} }),
    diagramSteps: (trace) =>
      trace.map((e) => ({
        node: `n_${e.step}`,
        output: e.output, errored: e.threw, duration: e.duration,
      })),
  });
}

/* ================================================================== */
/* 5. Multi-input + convergence                                       */
/* ================================================================== */

const multiActivity = activity((a) => {
  const start = a.entry('in');
  const ok = a.exit('ok');

  const trigger = a.addNode('trigger', node(async (ctx) => {
    await delay(5, 25);
    return { output: ctx.path, ctx };
  }, { outputs: ['retry', 'skip'] }));

  const recover = a.addNode('recover', node(async (ctx, _local, runInfo) => {
    await delay(20, 80);
    switch (runInfo.input) {
      case 'retry':
        return { output: 'ok', ctx: { ...ctx, viaInput: 'retry', retried: true } };
      case 'skip':
        return { output: 'ok', ctx: { ...ctx, viaInput: 'skip', skipped: true } };
    }
    return 'ok';
  }, { inputs: ['retry', 'skip'], outputs: ['ok'] }));

  a.wire(start,                trigger);
  a.wire(trigger.out('retry'), recover.in('retry'));
  a.wire(trigger.out('skip'),  recover.in('skip'));
  a.wire(recover.out('ok'),    ok);
});
multiActivity.check();

const MI_GRAPH = `flowchart LR
  start([in])
  n_trigger["trigger"]
  n_recover["recover<br/><span style='font-size: 10px; color: #6b635a'>inputs: retry · skip</span>"]
  endExit_ok([ok])
  start --> n_trigger
  n_trigger -- "retry" --> n_recover
  n_trigger -- "skip" --> n_recover
  n_recover -- "ok" --> endExit_ok`;

const miScenarios = {
  retry: { input: { path: 'retry' } },
  skip:  { input: { path: 'skip' } },
};

const multiFlow = flow('multi-input', multiActivity);

async function setupMultiInputDemo() {
  await bootDemo({
    prefix: 'mi',
    graph: MI_GRAPH,
    scenarios: miScenarios,
    runFn: (input) => multiFlow.run(input, { logger: () => {} }),
    diagramSteps: (trace) =>
      trace.map((e) => ({
        node: `n_${e.step}`,
        output: e.output, errored: e.threw, duration: e.duration,
      })),
  });
}

/* ================================================================== */
/* 6. Retry loop with `local` (cycle in the wire graph)               */
/* ================================================================== */

// Two nodes form the loop: `send` performs the (flaky) work, `decide`
// inspects the outcome and either gives up or routes back to `send`
// via the cycle wire. The retry counter lives in `decide.local.tries`
// — read as a parameter, written via the StepReturn. Cycles in the
// wire graph are valid topology; what makes the loop terminate is
// step logic, not graph structure (§7.4, §9.13).
const loopActivity = activity((a) => {
  const start                = a.entry('in');
  const { success, failure } = a.standardExits();

  const send = a.addNode('send', node(async (ctx) => {
    await delay(40, 140);
    const attempt = (ctx.attempt ?? 0) + 1;
    const ok = attempt >= (ctx.succeedOn ?? Infinity);
    if (ok) {
      return { output: 'ok', ctx: { ...ctx, attempt, response: 'delivered' } };
    }
    return { output: 'failed', ctx: { ...ctx, attempt, lastError: '5xx' } };
  }, { outputs: ['ok', 'failed'] }));

  const decide = a.addNode('decide', node(async (ctx, local) => {
    await delay(8, 24);
    const tries = (local.tries ?? 0) + 1;
    if (tries >= (ctx.maxTries ?? 3)) {
      return { output: 'giveup', ctx: { ...ctx, tries }, local: { tries } };
    }
    return { output: 'retry', ctx: { ...ctx, tries }, local: { tries } };
  }, { outputs: ['retry', 'giveup'] }));

  a.wire(start,                send);
  a.wire(send.out('ok'),       success);
  a.wire(send.out('failed'),   decide);
  a.wire(decide.out('retry'),  send);     // ← cycle
  a.wire(decide.out('giveup'), failure);
});
loopActivity.check();

const LOOP_GRAPH = `flowchart LR
  start([in])
  n_send["send"]
  n_decide["decide<br/><span style='font-size: 10px; color: #6b635a'>local.tries</span>"]
  endExit_success([ok])
  endExit_failure([giveup])
  start --> n_send
  n_send -- "ok" --> endExit_success
  n_send -- "failed" --> n_decide
  n_decide -- "retry" --> n_send
  n_decide -- "giveup" --> endExit_failure`;

const loopScenarios = {
  succeed: { input: { succeedOn: 3, maxTries: 5 } },
  giveup:  { input: { succeedOn: 99, maxTries: 3 } },
};

const loopFlow = flow('retry-loop', loopActivity);

async function setupLoopDemo() {
  await bootDemo({
    prefix: 'loop',
    graph: LOOP_GRAPH,
    scenarios: loopScenarios,
    runFn: (input) => loopFlow.run(input, { logger: () => {} }),
    diagramSteps: (trace) =>
      trace.map((e) => ({
        node: `n_${e.step}`,
        output: e.output, errored: e.threw, duration: e.duration,
      })),
  });
}

/* ================================================================== */
/* Boot                                                               */
/* ================================================================== */

await setupHero();
await setupSendMessageDemo();
await setupSubDemo();
await setupParallelDemo();
await setupExceptionDemo();
await setupMultiInputDemo();
await setupLoopDemo();

/* ================================================================== */
/* Source-code panels                                                 */
/* ================================================================== */

const SRC_SENDMESSAGE = `import { activity, node, catching, flow } from '@isnogudus/rail.js';

const sendMessage = activity((a) => {
  const start = a.entry('in');
  const { success, failure } = a.standardExits();

  const validate = a.addNode('validate', node(async (ctx) => {
    if (!ctx.roomId) return 'invalid';
    return { output: 'ok', ctx: { ...ctx, validated: true } };
  }, { outputs: ['ok', 'invalid'] }));

  const encrypt = a.addNode('encrypt', node(async (ctx) => {
    if (!ctx.keys) return 'noKeys';
    return { output: 'ok', ctx: { ...ctx, encrypted: true } };
  }, { outputs: ['ok', 'noKeys'] }));

  const send = a.addNode('send', catching(
    node(async (ctx) => {
      await fetch(ctx.url, { body: ctx.body });
      return 'ok';
    }, { outputs: ['ok'] }),
    { NetworkError: 'net5xx' }
  ));

  a.wire(start,                   validate);
  a.wire(validate.out('ok'),      encrypt);
  a.wire(validate.out('invalid'), failure);
  a.wire(encrypt.out('ok'),       send);
  a.wire(encrypt.out('noKeys'),   failure);
  a.wire(send.out('ok'),          success);
  a.wire(send.out('net5xx'),      failure);
});
sendMessage.check();

const r = await flow('sendMessage', sendMessage).run(ctx);
//   r.terminus  → 'success' | 'failure'
//   r.ctx       → final running ctx
//   r.trace     → ordered TraceEntry[]
`;

const SRC_SUB = `const inner = activity((a) => {
  const start = a.entry('in');
  const { success, failure } = a.standardExits();

  const encrypt = a.addNode('encrypt', node(async (ctx) => {
    if (!ctx.keys) return 'noKeys';
    return { output: 'ok', ctx: { ...ctx, encrypted: true } };
  }, { outputs: ['ok', 'noKeys'] }));

  const send = a.addNode('send', node(async (ctx) => ({
    output: 'ok',
    ctx: { ...ctx, sent: true },
  }), { outputs: ['ok'] }));

  a.wire(start,                 encrypt);
  a.wire(encrypt.out('ok'),     send);
  a.wire(encrypt.out('noKeys'), failure);
  a.wire(send.out('ok'),        success);
});

const outer = activity((a) => {
  const start = a.entry('in');
  const { success, failure } = a.standardExits();

  const preflight = a.addNode('preflight', node(
    (ctx) => (ctx.skip ? 'skip' : 'ok'),
    { outputs: ['ok', 'skip'] }
  ));
  const wrapped = a.addNode('inner', inner);   // <-- activity as sub-node

  a.wire(start,                  preflight);
  a.wire(preflight.out('ok'),    wrapped);
  a.wire(preflight.out('skip'),  success);
  a.wire(wrapped.out('success'), success);
  a.wire(wrapped.out('failure'), failure);
});
outer.check();   // recursively compiles \`inner\`

// Trace from outer.run():
//   preflight        depth=0
//   inner.encrypt    depth=1   ← prefixed with the sub-name
//   inner.send       depth=1
//   inner            depth=0   ← compound entry sits at outer's depth
`;

const SRC_PAR = `import { activity, node, parallel, flow, isParallelCtx } from '@isnogudus/rail.js';

const profileBranch = activity((a) => {
  const start = a.entry('in');
  const { success, failure } = a.standardExits();
  const fetch = a.addNode('fetch', node(async (ctx) => {
    if (ctx.profileFails) return 'failure';
    return { output: 'success', ctx: { ...ctx,
      profile: { id: ctx.userId, name: 'Markus' } } };
  }, { outputs: ['success', 'failure'] }));
  a.wire(start, fetch);
  a.wire(fetch.out('success'), success);
  a.wire(fetch.out('failure'), failure);
});

const keysBranch = activity((a) => {
  const start = a.entry('in');
  const { success, failure } = a.standardExits();
  const fetch = a.addNode('fetch', node(async (ctx) => ({
    output: 'success', ctx: { ...ctx, keys: ['k-1', 'k-2'] },
  }), { outputs: ['success', 'failure'] }));
  a.wire(start, fetch);
  a.wire(fetch.out('success'), success);
  a.wire(fetch.out('failure'), failure);
});

const loadProfileAndKeys = activity((a) => {
  const start = a.entry('in');
  const ok = a.exit('ok');
  const failed = a.exit('failed');

  const fan = a.addNode('fan', parallel({
    profile: profileBranch,
    keys:    keysBranch,
  }));

  const evaluate = a.addNode('evaluate', node((ctx) => {
    if (!isParallelCtx(ctx)) return 'failed';
    const { inputCtx, results } = ctx;
    if (results.profile.terminus !== 'success' ||
        results.keys.terminus    !== 'success') {
      return { output: 'failed', ctx: { ...inputCtx, errored: true } };
    }
    return {
      output: 'ok',
      ctx: {
        ...inputCtx,
        profile: results.profile.ctx.profile,
        keys:    results.keys.ctx.keys,
      },
    };
  }, { outputs: ['ok', 'failed'] }));

  a.wire(start,                  fan);
  a.wire(fan.out('done'),        evaluate);
  a.wire(evaluate.out('ok'),     ok);
  a.wire(evaluate.out('failed'), failed);
});
loadProfileAndKeys.check();
`;

const SRC_EXC = `import { activity, node, flow, exceptionCtx, isExceptionCtx } from '@isnogudus/rail.js';

const robust = activity((a) => {
  const start = a.entry('in');
  const { success, failure } = a.standardExits();

  const op = a.addNode('op', node(async (ctx) => {
    try {
      const r = await dangerousOp(ctx);
      return { output: 'ok', ctx: { ...ctx, result: r } };
    } catch (e) {
      // wrap the caught error as structured ctx for the graph
      return { output: 'failed', ctx: exceptionCtx(e, ctx) };
    }
  }, { outputs: ['ok', 'failed'] }));

  const recover = a.addNode('recover', node((ctx) => {
    if (!isExceptionCtx(ctx)) return { output: 'fatal', ctx };
    const { inputCtx, error } = ctx;
    if (error.name === 'TimeoutError') {
      return { output: 'ok', ctx: { ...inputCtx, retried: true } };
    }
    return { output: 'fatal', ctx: { ...inputCtx, lastError: error.name } };
  }, { outputs: ['ok', 'fatal'] }));

  a.wire(start,                op);
  a.wire(op.out('ok'),         success);
  a.wire(op.out('failed'),     recover);
  a.wire(recover.out('ok'),    success);   // retry path → success
  a.wire(recover.out('fatal'), failure);   // escalation  → failure
});
robust.check();
`;

const SRC_MI = `const multi = activity((a) => {
  const start = a.entry('in');
  const ok = a.exit('ok');

  const trigger = a.addNode('trigger', node(
    (ctx) => ({ output: ctx.path, ctx }),
    { outputs: ['retry', 'skip'] }
  ));

  // Multi-input step: declare two input ports.
  // The activated port is exposed to the step as runInfo.input.
  const recover = a.addNode('recover', node((ctx, _local, runInfo) => {
    switch (runInfo.input) {
      case 'retry':
        return { output: 'ok', ctx: { ...ctx, retried: true } };
      case 'skip':
        return { output: 'ok', ctx: { ...ctx, skipped: true } };
    }
    return 'ok';
  }, { inputs: ['retry', 'skip'], outputs: ['ok'] }));

  // Two wires converge on \`recover\`, each into a distinct input port.
  a.wire(start,                trigger);
  a.wire(trigger.out('retry'), recover.in('retry'));
  a.wire(trigger.out('skip'),  recover.in('skip'));
  a.wire(recover.out('ok'),    ok);
});
multi.check();
`;

const SRC_LOOP = `const loop = activity((a) => {
  const start                = a.entry('in');
  const { success, failure } = a.standardExits();

  // 'send' performs the flaky work. It owns no retry state — that's
  // the next node's job. Each invocation either succeeds or returns
  // 'failed'.
  const send = a.addNode('send', node(async (ctx) => {
    const attempt = (ctx.attempt ?? 0) + 1;
    if (attempt >= ctx.succeedOn) {
      return { output: 'ok', ctx: { ...ctx, attempt, response: 'delivered' } };
    }
    return { output: 'failed', ctx: { ...ctx, attempt, lastError: '5xx' } };
  }, { outputs: ['ok', 'failed'] }));

  // 'decide' counts retries in its position-local workspace 'local'.
  // 'local' is symmetric to ctx: read as a parameter, written via
  // the StepReturn. Cycles in the wire graph are valid topology —
  // what makes the loop terminate is step logic, not graph structure.
  const decide = a.addNode('decide', node(async (ctx, local) => {
    const tries = (local.tries ?? 0) + 1;
    if (tries >= ctx.maxTries) {
      return { output: 'giveup', ctx: { ...ctx, tries }, local: { tries } };
    }
    return { output: 'retry', ctx: { ...ctx, tries }, local: { tries } };
  }, { outputs: ['retry', 'giveup'] }));

  a.wire(start,                send);
  a.wire(send.out('ok'),       success);
  a.wire(send.out('failed'),   decide);
  a.wire(decide.out('retry'),  send);     // ← cycle
  a.wire(decide.out('giveup'), failure);
});

const r = await flow('retry-loop', loop).run({ succeedOn: 3, maxTries: 5 });
//   trace alternates send / decide entries; decide's 'local' grows
//   { tries: 1 } → { tries: 2 } until either send returns 'ok' or
//   decide returns 'giveup'.
`;

const SOURCES = {
  'demo-source': SRC_SENDMESSAGE,
  'sub-source':  SRC_SUB,
  'par-source':  SRC_PAR,
  'exc-source':  SRC_EXC,
  'mi-source':   SRC_MI,
  'loop-source': SRC_LOOP,
};

for (const [id, src] of Object.entries(SOURCES)) {
  const el = document.getElementById(id);
  if (el) el.textContent = src.trim() + '\n';
}

/* ================================================================== */
/* Tab wiring                                                         */
/* ================================================================== */

for (const tabsEl of document.querySelectorAll('.stage .tabs')) {
  const stage = tabsEl.closest('.stage');
  if (!stage) continue;
  const buttons = tabsEl.querySelectorAll('.tab');
  const panels  = stage.querySelectorAll('.tab-panel');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      buttons.forEach((b) => b.classList.toggle('active', b === btn));
      panels.forEach((p) => p.classList.toggle('active', p.dataset.tab === target));
    });
  });
}
