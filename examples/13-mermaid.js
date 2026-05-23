/**
 * §2.4 — Mermaid rendering.
 *
 * `flow.toMermaid({ direction })` produces a `flowchart` string that
 * can be embedded in markdown or rendered by Mermaid.
 */

import { activity, step, parallel, flow } from '../rail.js';

const inner = activity((a) => {
  a.entry('in');
  a.addNode('x', step(async () => {}));
  a.exit('done');
  a.wire('.in', 'x.success');
  a.wire('x.success', '.done');
  a.wire('x.failure', '.done');
});

const fan = parallel({
  fast: step(async () => {}),
  slow: step(async () => {}),
});

const outer = activity((a) => {
  a.entry('in');
  a.addNode('child', inner);
  a.addNode('par',   fan);
  a.exit('done');
  a.wire('.in',          'child.in');
  a.wire('child.done',   'par.in');
  a.wire('par.out',      '.done');
});

const f = flow('demo', outer);
console.log('--- LR ---');
console.log(f.toMermaid());
console.log('\n--- TB ---');
console.log(f.toMermaid({ direction: 'TB' }));
