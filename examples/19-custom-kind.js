/**
 * §2 / §15.3 — Custom node kind via the exported `invokeNode`.
 *
 * Any plain object with the marker fields and an `_invoke` method
 * is treated as a Rail-Node. Custom kinds that want the standard
 * framing (trace push, step-budget, kill check, tracer events,
 * `local._cycles`) build `_invoke` as a thin wrapper around
 * `invokeNode(doInvoke, kind, ...)`. Wrapper kinds that want to be
 * transparent in the trace build `_invoke` directly.
 */

import { activity, flow, invokeNode, isRailNode } from '../rail.js';

// A custom "delay" atomic kind: sleeps for ctx.ms milliseconds and
// always routes to the only declared output.
function delayNode() {
  const node = {
    __rail_type__: 'node',
    __rail_kind__: 'delay',         // any string — not a built-in
    inputs:  ['in'],
    outputs: ['out'],
  };

  async function doInvoke(_entry, ctx, _local, runState, _path, _traceEntry) {
    const ms = ctx.ms ?? 0;
    await new Promise((r) => setTimeout(r, ms));
    ctx.slept = true;
    void runState;                  // unused here, but available for I/O
    return 'out';
  }

  node._invoke = (entry, ctx, local, runState, path) =>
    invokeNode(doInvoke, node.__rail_kind__, entry, ctx, local, runState, path);

  return node;
}

const delay = delayNode();

console.log('isRailNode :', isRailNode(delay));
console.log('kind       :', delay.__rail_kind__);

const wf = activity((a) => {
  a.entry('in');
  a.addNode('sleep', delay);
  a.exit('done');
  a.wire('.in', 'sleep.in');
  a.wire('sleep.out', '.done');
});

const r = await flow('demo', wf).run({ ms: 20 }, { logger: () => {} });
console.log('exit  :', r.exit);
console.log('ctx   :', r.ctx);
// Trace shows the custom kind:
console.log('kinds :', r.trace.map((t) => t.kind));
