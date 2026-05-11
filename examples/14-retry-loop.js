/**
 * Retry pattern with `local` and a cycle (§9.13).
 *
 * Cycles in the wire graph are valid. The step uses its `local`
 * parameter to track retry attempts; the wire from `op.out('retry')`
 * loops back to `op`. After three tries, the step returns 'giveup'
 * and reaches the failure exit — modelled entirely in the graph
 * without any hidden library state.
 */

import { activity, node, flow } from '../rail.js';

const retryFlow = activity((a) => {
  const start                = a.entry('in');
  const { success, failure } = a.standardExits();

  const op = a.addNode('op', node(async (ctx, local) => {
    const tries = (local.tries ?? 0) + 1;
    if (tries > 3) return { output: 'giveup', local: { tries } };

    // Simulated flaky operation: succeed on the 3rd attempt.
    const ok = tries >= 3;
    if (ok) return { output: 'ok', ctx: { ...ctx, attempts: tries }, local: { tries } };
    return { output: 'retry', local: { tries } };
  }, { outputs: ['ok', 'retry', 'giveup'] }));

  a.wire(start,            op);
  a.wire(op.out('retry'),  op);          // ← valid cycle
  a.wire(op.out('ok'),     success);
  a.wire(op.out('giveup'), failure);
});

const main = flow('retry', retryFlow);
const result = await main.run({}, { logger: () => {} });
console.log('terminus:', result.terminus, '— attempts:', result.ctx.attempts);

console.log('trace:');
for (const t of result.trace) {
  console.log(`  ${t.step} #${t.invocation} -> ${t.output}  local=${JSON.stringify(t.local)}`);
}
