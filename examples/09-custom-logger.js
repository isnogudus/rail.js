/**
 * §14.11 — Custom logger.
 *
 * Each `flow.run(...)` can be given an `opts.logger`. The logger is
 * called once per successfully completed step. Steps that ended in a
 * library throw produce no logger output (they have no 'end' event).
 */

import { activity, step, flow } from '../rail.js';

const wf = activity((a) => {
  a.entry('in');
  a.addNode('a', step(async (ctx) => { ctx.a = 1; }));
  a.addNode('b', step(async (ctx) => { ctx.b = 2; }));
  a.exit('done');
  a.wire('.in', 'a.success');
  a.wire('a.success', 'b.success');
  a.wire('a.failure', '.done');
  a.wire('b.success', '.done');
  a.wire('b.failure', '.done');
});

await flow('logged', wf).run({}, {
  logger: (entry) => {
    const path = entry.path.length === 0 ? '<top>' : entry.path.join('.');
    const dur = (entry.endTime - entry.startTime).toFixed(2);
    console.log(`${path.padEnd(8)} ${dur.padStart(6)}ms → ${entry.exit}`);
  },
});
