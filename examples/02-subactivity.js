/**
 * §9.3 — Sub-activity composition.
 *
 * An Activity can be embedded as a sub-node inside another Activity.
 * The outer's compile recursively compiles the inner. Inner step
 * names appear in the trace as `<sub-name>.<inner-step>`, and the
 * compound entry sits at the outer's depth.
 */

import { activity, node, flow } from '../rail.js';

const inner = activity((a) => {
  const start = a.entry('in');
  const { success, failure } = a.standardExits();

  const encrypt = a.addNode('encrypt', node((ctx) => {
    if (!ctx.keys) return 'noKeys';
    return { output: 'ok', ctx: { ...ctx, encrypted: true } };
  }, { outputs: ['ok', 'noKeys'] }));

  const send = a.addNode('send', node(() => 'ok',
    { outputs: ['ok', 'net5xx'] }));

  a.wire(start,                  encrypt);
  a.wire(encrypt.out('ok'),      send);
  a.wire(encrypt.out('noKeys'),  failure);
  a.wire(send.out('ok'),         success);
  a.wire(send.out('net5xx'),     failure);
});

const outer = activity((a) => {
  const start = a.entry('in');
  const { success, failure } = a.standardExits();

  const preflight = a.addNode('preflight', node((ctx) =>
    ctx.skip ? 'skip' : 'ok', { outputs: ['ok', 'skip'] }));

  const wrapped = a.addNode('inner', inner);

  a.wire(start,                  preflight);
  a.wire(preflight.out('ok'),    wrapped);
  a.wire(preflight.out('skip'),  success);
  a.wire(wrapped.out('success'), success);
  a.wire(wrapped.out('failure'), failure);
});

outer.check();

console.log('--- happy path ---');
const ok = await flow('outer', outer).run({ keys: 'k' });
console.log('terminus:', ok.terminus, '\n');

console.log('--- skipped via preflight ---');
const skip = await flow('outer', outer).run({ skip: true });
console.log('terminus:', skip.terminus, '\n');

console.log('--- inner failure (no keys) ---');
const fail = await flow('outer', outer).run({});
console.log('terminus:', fail.terminus);
