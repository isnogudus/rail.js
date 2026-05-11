/**
 * §9.1 — Minimal happy-path activity.
 *
 * The smallest useful workflow: one entry, one exit, one step.
 */

import { activity, node, flow } from '../rail.js';

const greet = activity((a) => {
  const start = a.entry('in');
  const success = a.exit('success');

  const hello = a.addNode('hello', node(async (ctx) => ({
    output: 'success',
    ctx: { ...ctx, greeting: `Hello, ${ctx.name}!` },
  }), { outputs: ['success'] }));

  a.wire(start,                hello);
  a.wire(hello.out('success'), success);
});

greet.check();

const r = await flow('greet', greet).run({ name: 'Markus' });
console.log('terminus:', r.terminus);
console.log('greeting:', r.ctx.greeting);
