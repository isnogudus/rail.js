/**
 * §9.7 — Top-level Step-Node held directly by a flow.
 *
 * A flow can hold any Rail-Node, not just an Activity. Useful for
 * isolated step logic, micro-workflows, and unit tests.
 */

import { node, flow } from '../rail.js';

const greet = node(async (ctx) => ({
  output: 'done',
  ctx: { ...ctx, msg: `Hi ${ctx.name}` },
}), { outputs: ['done'] });

greet.check();

const r = await flow('greet', greet).run({ name: 'Markus' });
console.log('terminus:', r.terminus);
console.log('msg:', r.ctx.msg);

// flow.toMermaid() also works for a top-level Step-Node — minimal
// diagram with one synthetic entry and one synthetic exit per output.
console.log('\n--- Mermaid ---');
console.log(flow('greet', greet).toMermaid());
