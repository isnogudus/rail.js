/**
 * §14.1 — Minimal happy-path activity.
 *
 * A single-step activity that mutates ctx and exits at 'success'.
 */

import { activity, step, flow } from '../rail.js';

const greet = activity((a) => {
  a.entry('in');
  a.addNode('say', step(async (ctx) => {
    ctx.message = `hello, ${ctx.name}`;
  }));
  a.exit('done');
  a.wire('.in', 'say.success');
  a.wire('say.success', '.done');
  a.wire('say.failure', '.done');
});

const r = await flow('greet', greet).run({ name: 'world' });
console.log('exit:', r.exit);
console.log('ctx :', r.ctx);
