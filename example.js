/**
 * rail.js v0.3.0 — overview demo.
 *
 * A small workflow with: an atomic step, a sub-activity, a parallel
 * fan-out with merge, and a railway pipeline. Run with `npm run example`.
 */

import {
  activity, atom, step, parallel, railway, pin, flow,
} from './rail.js';

const validateInput = step(async (ctx) => {
  if (!ctx.userId) throw new Error('userId required');
});

const enrich = parallel({
  profile: step(async (ctx) => { ctx.profile = `profile:${ctx.userId}`; }),
  orders:  step(async (ctx) => { ctx.orders  = `orders:${ctx.userId}`;  }),
}, atom(async (ctx) => {
  const userId  = ctx.profile.userId;
  const profile = ctx.profile.profile;
  const orders  = ctx.orders.orders;
  for (const k of Object.keys(ctx)) delete ctx[k];
  ctx.userId = userId;
  ctx.profile = profile;
  ctx.orders = orders;
  return 'out';
}, { outputs: ['out'] }));

const report = railway((r) => {
  r.step('format', async (ctx) => {
    ctx.report = `${ctx.userId} → ${ctx.profile} | ${ctx.orders}`;
  });
  r.pass('audit', async () => { /* best-effort logging */ });
});

const main = activity((a) => {
  a.entry('in');
  a.addNode('validate', validateInput);
  a.addNode('enrich',   enrich);
  a.addNode('report',   pin(report, 'success'));
  a.exit('done');
  a.exit('invalid');

  a.wire('.in',                  'validate.success');
  a.wire('validate.success',     'enrich.in');
  a.wire('validate.failure',     '.invalid');
  a.wire('enrich.out',           'report.in');
  a.wire('report.success',       '.done');
  a.wire('report.failure',       '.invalid');
});

const r = await flow('overview', main).run({ userId: 'u-1' });
console.log('exit:', r.exit);
console.log('ctx :', r.ctx);
