/**
 * §3.12 — Typed contexts.
 *
 * A ctx with `__type: '<name>'` declares its shape. The library uses:
 *
 *   - `__type: 'exception'` — produced by `exceptionCtx(err, ctx)`
 *   - `__type: 'parallel-results'` — produced by `parallel(...)`
 *
 * User code can introduce its own types — useful for routing
 * structured payloads through downstream evaluators.
 */

import {
  activity,
  node,
  flow,
  exceptionCtx,
  isExceptionCtx,
  ctxType,
} from '../rail.js';

// A custom typed ctx for incoming-message routing.
function incomingCtx(payload) {
  return { __type: 'incoming', ...payload };
}

const router = activity((a) => {
  const start = a.entry('in');
  const handled = a.exit('handled');
  const dropped = a.exit('dropped');
  const errored = a.exit('errored');

  const receive = a.addNode('receive', node(async (ctx) => {
    try {
      if (ctx.kind === 'fail') throw new Error('bad payload');
      if (ctx.kind === 'spam') return 'drop';
      return { output: 'ok', ctx: incomingCtx({ id: ctx.id, body: ctx.body }) };
    } catch (e) {
      return { output: 'err', ctx: exceptionCtx(e, ctx) };
    }
  }, { outputs: ['ok', 'drop', 'err'] }));

  const handle = a.addNode('handle', node((ctx) => {
    // Generic dispatch on __type — useful when one node terminates
    // multiple sources of structured data.
    switch (ctxType(ctx)) {
      case 'incoming':
        return { output: 'ok', ctx: { handled: ctx.id, body: ctx.body } };
      case 'exception':
        return { output: 'err', ctx };
      default:
        return 'err';
    }
  }, { outputs: ['ok', 'err'] }));

  const errorEval = a.addNode('errorEval', node((ctx) => {
    if (isExceptionCtx(ctx)) {
      return { output: 'ok', ctx: { errored: true, name: ctx.error.name, msg: ctx.error.message } };
    }
    return 'ok';
  }, { outputs: ['ok'] }));

  a.wire(start,                receive);
  a.wire(receive.out('ok'),    handle);
  a.wire(receive.out('drop'),  dropped);
  a.wire(receive.out('err'),   errorEval);
  a.wire(handle.out('ok'),     handled);
  a.wire(handle.out('err'),    errorEval);
  a.wire(errorEval.out('ok'),  errored);
});
router.check();

const f = flow('router', router);
const silent = { logger: () => {} };

console.log('--- ok ---');
console.log(await f.run({ kind: 'ok', id: 1, body: 'hi' }, silent));

console.log('\n--- spam ---');
console.log(await f.run({ kind: 'spam' }, silent));

console.log('\n--- fail ---');
console.log(await f.run({ kind: 'fail' }, silent));
