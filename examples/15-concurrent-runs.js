/**
 * Stateless flow + concurrent runs.
 *
 * `flow(...)` returns a stateless object: all run-time state lives
 * in the closure of `run(...)`. The same flow object can be invoked
 * many times concurrently — each run is fully independent (its own
 * counter, ctx, trace, signals).
 */

import { activity, node, flow } from '../rail.js';

const slowAdder = activity((a) => {
  const start = a.entry('in');
  const ok = a.exit('ok');
  const add = a.addNode('add', node(async (ctx) => {
    await new Promise((r) => setTimeout(r, Math.random() * 30));
    return { output: 'ok', ctx: { ...ctx, sum: ctx.a + ctx.b } };
  }, { outputs: ['ok'] }));
  a.wire(start, add);
  a.wire(add.out('ok'), ok);
});
slowAdder.check();

const f = flow('slowAdder', slowAdder);

// Launch 5 concurrent runs on the SAME flow object. They do not
// interfere — each gets its own run-state in its own closure.
const results = await Promise.all(
  Array.from({ length: 5 }, (_, i) =>
    f.run({ a: i, b: i * 2 }, { logger: () => {} })
  )
);

for (const [i, r] of results.entries()) {
  console.log(`run ${i}: terminus=${r.terminus}, sum=${r.ctx.sum}, traceLen=${r.trace.length}`);
}
