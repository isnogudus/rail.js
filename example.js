/**
 * Runnable examples for rail.js. Run with: `npm run example`
 *
 * Mirrors the §9 examples from docs/rail-spec.md:
 *   - sendMessage (validate / encrypt / send) with `catching`
 *   - sub-activity composition
 *   - parallel + evaluate
 *   - exceptionCtx + downstream evaluator
 */

import {
  activity,
  node,
  parallel,
  catching,
  flow,
  exceptionCtx,
  isExceptionCtx,
  isParallelCtx,
} from './rail.js';

/* ------------------------------------------------------------------ */
/* §9.2 — sendMessage                                                  */
/* ------------------------------------------------------------------ */

class NetworkError extends Error {
  constructor(message) { super(message); this.name = 'NetworkError'; }
}

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
    node(async (_ctx) => {
      // In a real flow this would call fetch(...). We simulate.
      return 'ok';
    }, { outputs: ['ok'] }),
    { NetworkError: 'net5xx', AbortError: 'cancelled' }
  ));

  a.wire(start, validate);
  a.wire(validate.out('ok'), encrypt);
  a.wire(validate.out('invalid'), failure);
  a.wire(encrypt.out('ok'), send);
  a.wire(encrypt.out('noKeys'), failure);
  a.wire(send.out('ok'), success);
  a.wire(send.out('net5xx'), failure);
  a.wire(send.out('cancelled'), failure);
});

sendMessage.compile();
const sendMessageFlow = flow('sendMessage', sendMessage);

/* ------------------------------------------------------------------ */
/* §9.5 — parallel + evaluate                                          */
/* ------------------------------------------------------------------ */

const profileBranch = activity((a) => {
  const s = a.entry('in');
  const { success, failure } = a.standardExits();
  const fetch = a.addNode('fetch', node((c) => ({
    output: 'success',
    ctx: { ...c, profile: { id: c.userId, name: 'M.' } },
  }), { outputs: ['success', 'failure'] }));
  a.wire(s, fetch);
  a.wire(fetch.out('success'), success);
  a.wire(fetch.out('failure'), failure);
});

const keysBranch = activity((a) => {
  const s = a.entry('in');
  const { success, failure } = a.standardExits();
  const fetch = a.addNode('fetch', node((c) => ({
    output: 'success',
    ctx: { ...c, keys: ['k-1', 'k-2'] },
  }), { outputs: ['success', 'failure'] }));
  a.wire(s, fetch);
  a.wire(fetch.out('success'), success);
  a.wire(fetch.out('failure'), failure);
});

const loadProfileAndKeys = activity((a) => {
  const start = a.entry('in');
  const ok = a.exit('ok');
  const failed = a.exit('failed');

  const fan = a.addNode('parallel', parallel({
    profile: profileBranch,
    keys: keysBranch,
  }));

  const evaluate = a.addNode('evaluate', node((ctx) => {
    if (!isParallelCtx(ctx)) return 'failed';
    const { inputCtx, results } = ctx;
    if (results.profile.terminus !== 'success' ||
        results.keys.terminus !== 'success') {
      return { output: 'failed', ctx: { ...inputCtx, error: 'sub-failure' } };
    }
    return {
      output: 'ok',
      ctx: {
        ...inputCtx,
        profile: results.profile.ctx.profile,
        keys: results.keys.ctx.keys,
      },
    };
  }, { outputs: ['ok', 'failed'] }));

  a.wire(start, fan);
  a.wire(fan.out('done'), evaluate);
  a.wire(evaluate.out('ok'), ok);
  a.wire(evaluate.out('failed'), failed);
});

loadProfileAndKeys.compile();

/* ------------------------------------------------------------------ */
/* §9.6 — exceptionCtx + downstream evaluator                          */
/* ------------------------------------------------------------------ */

const robust = activity((a) => {
  const start = a.entry('in');
  const { success, failure } = a.standardExits();

  const op = a.addNode('op', node(async (ctx) => {
    try {
      if (ctx.kind === 'timeout') {
        const e = new Error('timed out'); e.name = 'TimeoutError'; throw e;
      }
      return { output: 'ok', ctx: { ...ctx, result: 42 } };
    } catch (e) {
      return { output: 'failed', ctx: exceptionCtx(e, ctx) };
    }
  }, { outputs: ['ok', 'failed'] }));

  const recover = a.addNode('recover', node(async (ctx) => {
    if (!isExceptionCtx(ctx)) return { output: 'fatal', ctx };
    const { inputCtx, error } = ctx;
    if (error.name === 'TimeoutError') {
      return { output: 'ok', ctx: { ...inputCtx, retried: true } };
    }
    return { output: 'fatal', ctx: { ...inputCtx, lastError: error } };
  }, { outputs: ['ok', 'fatal'] }));

  a.wire(start, op);
  a.wire(op.out('ok'), success);
  a.wire(op.out('failed'), recover);
  a.wire(recover.out('ok'), success);
  a.wire(recover.out('fatal'), failure);
});

robust.compile();

/* ------------------------------------------------------------------ */
/* Run all                                                            */
/* ------------------------------------------------------------------ */

console.log('=== sendMessage (happy path) ===');
let r = await sendMessageFlow.run({ roomId: 'room-1', keys: 'k', body: 'hi' });
console.log('terminus:', r.terminus);

console.log('\n=== sendMessage (invalid) ===');
r = await sendMessageFlow.run({ keys: 'k' });
console.log('terminus:', r.terminus);

console.log('\n=== loadProfileAndKeys ===');
r = await flow('loadProfileAndKeys', loadProfileAndKeys).run({ userId: 1 });
console.log('terminus:', r.terminus, '— profile:', r.ctx.profile, '— keys:', r.ctx.keys);

console.log('\n=== robust (timeout, recover) ===');
r = await flow('robust', robust).run({ kind: 'timeout' });
console.log('terminus:', r.terminus, '— ctx:', r.ctx);

console.log('\n=== Mermaid for sendMessage ===');
console.log(sendMessageFlow.toMermaid());
