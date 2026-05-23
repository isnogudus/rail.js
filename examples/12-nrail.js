/**
 * §14.14 — `nrail(builderFn)` with three outcome rails and cleanup.
 *
 * `validate` and `charge` each catch their own exceptions via
 * `catchTo` and route to dedicated rails. `cleanup` converges the
 * `fail` outputs of all three steps via per-rail convergence on
 * `cleanup.fail`.
 */

import { nrail, catchTo, flow } from '../rail.js';

const orderPipeline = nrail((r) => {
  r.entry('main');

  r.step('validate',
    catchTo(async (ctx) => {
      if (!ctx.orderId) throw new Error('missing orderId');
      return 'main';
    }, 'fail'),
    'main', ['main', 'fail']);

  r.step('charge',
    catchTo(async (ctx) => {
      ctx.tx = `tx-${ctx.orderId}`;
      return 'main';
    }, 'retry'),
    'main', ['main', 'retry', 'fail']);

  r.step('logRetry', async (ctx) => {
    ctx.retryLogged = ctx._error?.message ?? null;
    return 'fail';
  }, 'retry', 'fail');

  r.step('cleanup', async (ctx) => {
    ctx.cleanedUp = true;
  }, 'fail', 'fail');
});

console.log('outputs:', orderPipeline.outputs);

const ok = await flow('orders', orderPipeline).run({ orderId: '42' });
console.log('happy →', ok.exit, ok.ctx);

const bad = await flow('orders', orderPipeline).run({});
console.log('error →', bad.exit, bad.ctx);
