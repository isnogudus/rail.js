/**
 * §9.10 — Cooperative cancellation via `opts.signal`.
 *
 * The signal is exposed to step functions as `runInfo.signal`.
 * Steps decide how to react — typically by passing it through to
 * abortable I/O and converting an `AbortError` into a named output.
 *
 * Cancellation is a normal flow: a `'cancelled'` output, optional
 * cleanup, ending at a `cancelled` exit.
 */

import { activity, node, flow } from '../rail.js';

const upload = activity((a) => {
  const start     = a.entry('in');
  const ok        = a.exit('ok');
  const cancelled = a.exit('cancelled');
  const failure   = a.exit('failure');

  const validate = a.addNode('validate', node(
    (ctx) => (ctx.url ? 'ok' : 'invalid'),
    { outputs: ['ok', 'invalid'] }
  ));

  // Simulates a long upload that polls the signal.
  const send = a.addNode('send', node(async (ctx, runInfo) => {
    for (let i = 0; i < 50; i++) {
      if (runInfo.signal?.aborted) return 'cancelled';
      await new Promise((r) => setTimeout(r, 5));
    }
    return 'ok';
  }, { outputs: ['ok', 'cancelled', 'failed'] }));

  const cleanup = a.addNode('cleanup', node((ctx) => ({
    output: 'done',
    ctx: { ...ctx, cleanedUp: true },
  }), { outputs: ['done'] }));

  a.wire(start,                   validate);
  a.wire(validate.out('ok'),      send);
  a.wire(validate.out('invalid'), failure);
  a.wire(send.out('ok'),          ok);
  a.wire(send.out('cancelled'),   cleanup);
  a.wire(send.out('failed'),      failure);
  a.wire(cleanup.out('done'),     cancelled);
});
upload.compile();

const ctrl = new AbortController();
const promise = flow('upload', upload).run(
  { url: 'https://example.invalid/x', payload: 'data' },
  { signal: ctrl.signal, logger: () => {} }
);

// Cancel after 20ms (the send step polls every 5ms and notices).
setTimeout(() => ctrl.abort(), 20);

const r = await promise;
console.log('terminus:', r.terminus);
console.log('cleanedUp:', r.ctx.cleanedUp);
