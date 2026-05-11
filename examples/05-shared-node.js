/**
 * §9.8 — Reusing a step under multiple names.
 *
 * A single `node(...)` value can be added to multiple activities
 * (or to the same activity under different local names). The shared
 * implementation is compiled exactly once thanks to compile() being
 * idempotent and identity-based.
 */

import { activity, node, flow } from '../rail.js';

const validate = node((ctx) => {
  if (!ctx.value) return 'invalid';
  return { output: 'ok', ctx: { ...ctx, validatedAt: Date.now() } };
}, { outputs: ['ok', 'invalid'] });

// Used in flow A under one name.
const flowA = activity((a) => {
  const s = a.entry('in');
  const { success, failure } = a.standardExits();
  const v = a.addNode('validate', validate);
  a.wire(s, v);
  a.wire(v.out('ok'),      success);
  a.wire(v.out('invalid'), failure);
});

// Used in flow B twice under different names.
const flowB = activity((a) => {
  const s = a.entry('in');
  const { success, failure } = a.standardExits();
  const first  = a.addNode('preflight', validate);
  const second = a.addNode('recheck',   validate);
  a.wire(s,                        first);
  a.wire(first.out('ok'),          second);
  a.wire(first.out('invalid'),     failure);
  a.wire(second.out('ok'),         success);
  a.wire(second.out('invalid'),    failure);
});

flowA.check();
flowB.check();

console.log('flowA terminus:', (await flow('A', flowA).run({ value: 1 })).terminus);
console.log('flowB terminus:', (await flow('B', flowB).run({ value: 1 })).terminus);
