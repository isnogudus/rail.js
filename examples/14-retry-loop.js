/**
 * §14.13 — Retry pattern with `local` and a cycle wire.
 *
 * The `local` slot at the `fetch` position carries the attempt
 * counter across cycles within a single `flow.run(...)`. A new run
 * starts with a fresh empty `local`.
 */

import { activity, atom, flow, RailError } from '../rail.js';

let unreliableCalls = 0;
async function fakeFetch(url) {
  unreliableCalls++;
  if (unreliableCalls < 3) throw new Error(`transient (${unreliableCalls})`);
  return { url, body: 'OK' };
}

const fetchWithRetry = atom(async (ctx, local) => {
  local.attempts ??= 0;
  local.attempts++;
  try {
    ctx.data = await fakeFetch(ctx.url);
    return 'ok';
  } catch (err) {
    if (err instanceof RailError) throw err;
    if (local.attempts < 3) return 'retry';
    ctx.lastError = err.message;
    return 'giveUp';
  }
}, { outputs: ['ok', 'retry', 'giveUp'] });

const retrier = activity((a) => {
  a.entry('in');
  a.addNode('fetch', fetchWithRetry);
  a.exit('done');
  a.exit('failed');
  a.wire('.in',           'fetch.in');
  a.wire('fetch.ok',      '.done');
  a.wire('fetch.retry',   'fetch.in');   // cycle wire
  a.wire('fetch.giveUp',  '.failed');
});

const r = await flow('retrier', retrier).run({ url: '/api/data' });
console.log('exit:', r.exit);
console.log('ctx :', r.ctx);
// cycle counts visible in the trace:
const fetchEntries = r.trace.filter((t) => t.path.join('.') === 'fetch');
console.log('fetch cycles:', fetchEntries.map((e) => e.cycle));
