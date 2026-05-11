/**
 * Multi-input nodes — `runInfo.input` reports the activated port.
 *
 * Convergence on a single input is allowed; using distinct inputs
 * lets one step branch on which upstream path activated it.
 */

import { activity, node, flow } from '../rail.js';

const a = activity((a) => {
  const start = a.entry('in');
  const ok = a.exit('ok');

  const trigger = a.addNode('trigger', node(
    (ctx) => ({ output: ctx.path, ctx }),
    { outputs: ['retry', 'skip'] }
  ));

  const recover = a.addNode('recover', node((ctx, _local, runInfo) => {
    switch (runInfo.input) {
      case 'retry': return { output: 'ok', ctx: { ...ctx, retried: true } };
      case 'skip':  return { output: 'ok', ctx: { ...ctx, skipped: true } };
      default:      return 'ok';
    }
  }, { inputs: ['retry', 'skip'], outputs: ['ok'] }));

  a.wire(start,                trigger);
  a.wire(trigger.out('retry'), recover.in('retry'));
  a.wire(trigger.out('skip'),  recover.in('skip'));
  a.wire(recover.out('ok'),    ok);
});
a.check();

const f = flow('multi-input', a);

console.log('--- via retry input ---');
const retried = await f.run({ path: 'retry' });
console.log('ctx:', retried.ctx, '\n');

console.log('--- via skip input ---');
const skipped = await f.run({ path: 'skip' });
console.log('ctx:', skipped.ctx);
