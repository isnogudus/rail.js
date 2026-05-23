/**
 * §14.5 — `parallel(branches, merge?)` with a merge node.
 *
 * Two branches each receive a shallow copy of the incoming ctx and
 * enrich it independently. After both resolve, the parallel
 * aggregates as `{ branchName: branchCtx, ... }`. The merge node
 * then collapses this to a domain-shaped ctx and picks the exit.
 */

import { activity, atom, step, parallel, flow } from '../rail.js';

const fetchProfile = step(async (ctx) => {
  ctx.profile = `profile:${ctx.userId}`;
});

const fetchOrders = step(async (ctx) => {
  ctx.orders = [`order-A:${ctx.userId}`, `order-B:${ctx.userId}`];
});

const mergeResults = atom(async (ctx) => {
  const userId  = ctx.profile.userId;
  const profile = ctx.profile.profile;
  const orders  = ctx.orders.orders;
  for (const k of Object.keys(ctx)) delete ctx[k];
  ctx.userId = userId;
  ctx.profile = profile;
  ctx.orders = orders;
  return 'out';
}, { outputs: ['out'] });

const enrichBoth = parallel({
  profile: fetchProfile,
  orders:  fetchOrders,
}, mergeResults);

const r = await flow('enrich', enrichBoth).run({ userId: 'u-42' });
console.log('exit:', r.exit);
console.log('ctx :', r.ctx);
