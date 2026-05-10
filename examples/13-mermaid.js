/**
 * §3.11 — Mermaid render.
 *
 * Both `flow.toMermaid(opts?)` and `activity.toMermaid(name?, opts?)`
 * produce a `flowchart LR` (or TB) string. Sub-activities render as
 * subroutine shapes; parallel-nodes get a distinct marker.
 *
 * Pipe the output into any Mermaid renderer (mermaid-cli, the
 * Mermaid Live Editor, GitHub markdown, or your own viewer).
 */

import { activity, node, parallel, catching, flow } from '../rail.js';

class NetworkError extends Error {
  constructor(m) { super(m); this.name = 'NetworkError'; }
}

const innerSend = activity((a) => {
  const s = a.entry('in');
  const { success, failure } = a.standardExits();
  const enc = a.addNode('encrypt', node(() => 'ok',
    { outputs: ['ok', 'noKeys'] }));
  const send = a.addNode('send', catching(
    node(() => 'ok', { outputs: ['ok'] }),
    { NetworkError: 'net5xx' }
  ));
  a.wire(s, enc);
  a.wire(enc.out('ok'),     send);
  a.wire(enc.out('noKeys'), failure);
  a.wire(send.out('ok'),    success);
  a.wire(send.out('net5xx'),failure);
});

const par = parallel({
  profile: innerSend,                      // activity branch
  audit:   node(() => 'ok', { outputs: ['ok'] }), // step-node branch
});

const outer = activity((a) => {
  const start = a.entry('in');
  const { success, failure } = a.standardExits();
  const validate = a.addNode('validate', node(() => 'ok',
    { outputs: ['ok', 'invalid'] }));
  const fan = a.addNode('parallel', par);
  const inner = a.addNode('finish', innerSend);

  a.wire(start,                 validate);
  a.wire(validate.out('ok'),    fan);
  a.wire(validate.out('invalid'), failure);
  a.wire(fan.out('done'),       inner);
  a.wire(inner.out('success'),  success);
  a.wire(inner.out('failure'),  failure);
});
outer.compile();

console.log('--- flow.toMermaid (LR) ---');
console.log(flow('outer', outer).toMermaid());

console.log('\n--- activity.toMermaid("custom", { direction: "TB" }) ---');
console.log(outer.toMermaid('custom', { direction: 'TB' }));
