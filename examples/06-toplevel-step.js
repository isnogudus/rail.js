/**
 * §14.7 — Top-level atomic node held directly by a flow.
 *
 * `flow(name, node)` accepts any Rail-Node with exactly one input,
 * so an atomic node can be used directly without wrapping it in
 * an activity.
 */

import { atom, flow } from '../rail.js';

const greet = atom(async (ctx) => {
  const msg = `hi ${ctx.name}`;
  for (const k of Object.keys(ctx)) delete ctx[k];
  ctx.msg = msg;
  return 'out';
}, { outputs: ['out'] });

const r = await flow('greet', greet).run({ name: 'Mat' });
console.log('exit:', r.exit);
console.log('ctx :', r.ctx);
