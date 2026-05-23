/**
 * §14.15 — `railway(builderFn)` for the two-track success/failure pattern.
 *
 * Three builder methods, all with the same user-function signature
 * `fn(ctx, local, runInfo) → void`:
 *   r.step  — normal → success;  throw → failure (ctx._error set)
 *   r.pass  — normal → success;  throw → success (ctx._error set)
 *   r.fail  — normal → failure;  throw → failure (ctx._error set)
 *
 * Throw routing is via the built-in `catchTo` wrapper — no manual
 * try/catch needed in user functions.
 */

import { railway, flow } from '../rail.js';

const orderPipeline = railway((r) => {
  r.step('validate', async (ctx) => {
    if (!ctx.orderId) throw new Error('missing orderId');
  });

  r.step('charge', async (ctx) => {
    ctx.tx = `tx-${ctx.orderId}`;
  });

  r.pass('audit', async (ctx) => {
    // best-effort logging — throws never affect control flow here
    ctx.audited = true;
  });

  r.fail('cleanup', async (ctx) => {
    ctx.cleanedUp = true;
  });
});

console.log('inputs :', orderPipeline.inputs);
console.log('outputs:', orderPipeline.outputs);

const ok = await flow('orders', orderPipeline).run({ orderId: '42' });
console.log('happy →', ok.exit, ok.ctx);

const bad = await flow('orders', orderPipeline).run({});
console.log('error →', bad.exit, { error: bad.ctx._error?.message, cleanedUp: bad.ctx.cleanedUp });
