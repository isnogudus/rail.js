/**
 * Stateless flow + concurrent runs.
 *
 * Node values are immutable; per-run state lives in `runState` and
 * the per-run `local` tree (owned by `flow.run`). The same flow can
 * be invoked any number of times, including concurrently — no
 * coordination required.
 */

import { activity, step, flow } from '../rail.js';

const wf = activity((a) => {
  a.entry('in');
  a.addNode('work', step(async (ctx) => {
    await new Promise((r) => setTimeout(r, ctx.delay ?? 5));
    ctx.touched = ctx.id;
  }));
  a.exit('done');
  a.wire('.in', 'work.success');
  a.wire('work.success', '.done');
  a.wire('work.failure', '.done');
});

const f = flow('concurrent', wf);

const runs = await Promise.all([
  f.run({ id: 'a', delay: 30 }, { logger: () => {} }),
  f.run({ id: 'b', delay: 10 }, { logger: () => {} }),
  f.run({ id: 'c', delay: 20 }, { logger: () => {} }),
]);

for (const r of runs) {
  console.log(`run ${r.ctx.id}: exit=${r.exit}, traceLen=${r.trace.length}`);
}
