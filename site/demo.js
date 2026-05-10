/**
 * Live demo: run the actual rail.js sendMessage activity in the
 * browser, capture its trace + result, then drive the SVG diagram
 * (in diagrams.js) through the captured execution.
 */

import {
  activity,
  node,
  catching,
  flow,
} from '@isnogudus/rail.js';

import { playDemo } from './diagrams.js';

class NetworkError extends Error {
  constructor(message) { super(message); this.name = 'NetworkError'; }
}

/* ------------------------------------------------------------------ */
/* Activity definition                                                */
/* ------------------------------------------------------------------ */

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
sendMessage.compile();

const sendMessageFlow = flow('sendMessage', sendMessage);

/* ------------------------------------------------------------------ */
/* Scenarios                                                          */
/* ------------------------------------------------------------------ */

const scenarios = {
  happy:    { input: { roomId: 'room-1', keys: 'k', body: 'Hello' } },
  invalid:  { input: { keys: 'k', body: 'no roomId' } },
  net5xx:   { input: { roomId: 'room-1', keys: 'k', body: 'x', willNetworkError: true } },
  throws:   { input: { roomId: 'room-1', keys: 'k', body: 'x', willCrash: true } },
};

/* ------------------------------------------------------------------ */
/* DOM                                                                */
/* ------------------------------------------------------------------ */

const elTrace  = document.getElementById('demo-trace');
const elResult = document.getElementById('demo-result');
const buttons  = document.querySelectorAll('[data-demo]');

buttons.forEach((btn) => {
  btn.addEventListener('click', () => {
    buttons.forEach((b) => { b.classList.add('ghost'); b.classList.remove('active'); });
    btn.classList.remove('ghost'); btn.classList.add('active');
    runDemo(btn.dataset.demo);
  });
});

/* ------------------------------------------------------------------ */
/* Rendering                                                          */
/* ------------------------------------------------------------------ */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

function renderTrace(trace) {
  if (!trace || trace.length === 0) {
    elTrace.innerHTML = '<div class="empty">— no trace —</div>';
    return;
  }
  const html = trace.map((e) => {
    const tag    = e.threw ? 'xx' : 'ok';
    const tagTxt = e.threw ? 'XX' : 'OK';
    const out    = e.threw
      ? `<span class="out fail">${escapeHtml(e.error?.code ?? e.error?.name ?? 'ERR')}</span>`
      : `<span class="out">${escapeHtml(e.output)}</span>`;
    return `<div class="ln">
      <span class="tag ${tag}">${tagTxt}</span>
      <span class="name">${escapeHtml(e.step)}</span>
      <span class="arrow">→</span>
      ${out}
      <span class="dur">${e.duration.toFixed(2)}ms</span>
    </div>`;
  });
  elTrace.innerHTML = html.join('');
}

function renderResult(success, payload) {
  elResult.classList.remove('fail');
  if (success) {
    elResult.innerHTML =
      `<span class="label">terminus:</span> <span class="v">${escapeHtml(payload.terminus)}</span>\n\n` +
      `<span class="label">ctx:</span>\n${escapeHtml(formatJson(payload.ctx))}`;
  } else {
    elResult.classList.add('fail');
    elResult.textContent =
      `RailRuntimeError\n` +
      `  code:  ${payload.code}\n` +
      `  cause: ${payload.cause?.name ?? '—'}: ${payload.cause?.message ?? ''}`;
  }
}

/* ------------------------------------------------------------------ */
/* Run                                                                */
/* ------------------------------------------------------------------ */

async function runDemo(scenarioName) {
  const scenario = scenarios[scenarioName] ?? scenarios.happy;

  // Reset UI panels while the run is queued.
  elTrace.innerHTML = '<div class="empty">…running…</div>';
  elResult.textContent = '';
  elResult.classList.remove('fail');

  let trace, terminus, success = true, errored = false, payload;
  try {
    const r = await sendMessageFlow.run(scenario.input, { logger: () => {} });
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

  // Animate the diagram first; then publish trace + result so the UI
  // panels feel synced with the diagram's final state.
  await playDemo(trace, terminus, errored);
  renderTrace(trace);
  renderResult(success, payload);
}

/* Initial render */
runDemo('happy');
