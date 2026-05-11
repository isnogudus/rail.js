/**
 * §3.8 — `merge(stepFn)` convenience wrapper.
 *
 * Steps that just want to add fields to the running ctx (rather than
 * fully replace it) can return only the patch. The wrapper handles
 * the spread.
 */

import { activity, node, merge, flow } from '../rail.js';

// Without merge: explicit spread
const a1 = node(async (ctx) => ({
  output: 'ok',
  ctx: { ...ctx, validated: true, validatedAt: Date.now() },
}), { outputs: ['ok'] });

// With merge: just describe the patch
const a2 = merge(async (ctx) => ({
  output: 'ok',
  patch: { validated: true, validatedAt: Date.now() },
}));

const wf = activity((a) => {
  const start = a.entry('in');
  const ok = a.exit('ok');
  const without = a.addNode('without', a1);
  const withMerge = a.addNode('with', node(a2, { outputs: ['ok'] }));
  a.wire(start, without);
  a.wire(without.out('ok'), withMerge);
  a.wire(withMerge.out('ok'), ok);
});
wf.check();

const r = await flow('wf', wf).run({ id: 'x', body: 'hello' }, { logger: () => {} });
console.log('terminus:', r.terminus);
console.log('ctx:', r.ctx);
// All original fields (id, body) survive both steps. The validated
// fields appear without explicit spread thanks to merge().
