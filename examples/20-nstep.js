/**
 * §3.2 — `nstep(fn, inputs, outputs)`: string-or-array convenience
 * over `atom`, with single-output nullish-return.
 *
 * - Single name → automatic single-element array.
 * - Single-output node → user fn may return `undefined`, `null`, or
 *   the output name explicitly. All three resolve to that output.
 * - Multi-output node → user fn must return one of the declared
 *   outputs as a string.
 */

import { nstep, activity, flow } from '../rail.js';

// (a) Single output, nullish return — no `return` needed.
const audit = nstep(async (ctx) => { ctx.audited = true; }, 'in', 'success');

// (b) Single output, explicit return.
const explicit = nstep(async (ctx) => { ctx.touched = true; return 'success'; }, 'in', 'success');

// (c) Multi-output — must return one of the names.
const route = nstep(async (ctx) => {
  if (ctx.value > 10) return 'big';
  if (ctx.value > 0)  return 'small';
  return 'zero';
}, 'in', ['big', 'small', 'zero']);

// (d) Rail-named single-input (the nrail convention): name the
//     input after the rail it consumes.
const onSuccess = nstep(async (ctx) => { ctx.onRail = 'success'; }, 'success', 'success');

const wf = activity((a) => {
  a.entry('in');
  a.addNode('a', audit);
  a.addNode('b', explicit);
  a.addNode('r', route);
  a.addNode('o', onSuccess);
  a.exit('big', 'small', 'zero');
  a.wire('.in',     'a.in');
  a.wire('a.success', 'b.in');
  a.wire('b.success', 'r.in');
  a.wire('r.big',    'o.success');
  a.wire('r.small',  '.small');
  a.wire('r.zero',   '.zero');
  a.wire('o.success', '.big');
});

const r1 = await flow('demo', wf).run({ value: 5 },  { logger: () => {} });
console.log('value=5  →', r1.exit, r1.ctx);

const r2 = await flow('demo', wf).run({ value: 99 }, { logger: () => {} });
console.log('value=99 →', r2.exit, r2.ctx);

const r3 = await flow('demo', wf).run({ value: 0 },  { logger: () => {} });
console.log('value=0  →', r3.exit, r3.ctx);
