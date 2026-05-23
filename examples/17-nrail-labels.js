/**
 * §6.6 / §6.11 — `nrail` labels and links: loops and forward jumps.
 *
 * Labels are named anchors on a rail; links wire one or more
 * Live-Set entries to a label's input. The label is reachable
 * *only* through link — its Live-Set output starts fresh from the
 * label position. Forward links (link before label) work too.
 */

import { nrail, flow } from '../rail.js';

// (a) Retry loop with a label/link pair.
const retryFlow = nrail((r) => {
  r.entry('main');
  r.label('start', 'main');
  r.step('try', async (_ctx, local) => {
    local.n = (local.n ?? 0) + 1;
    return local.n >= 3 ? 'main' : 'retry';
  }, 'main', ['main', 'retry']);
  r.link('start', 'retry');         // back-edge: retry → start.in
});

const r1 = await flow('retry', retryFlow).run({}, { logger: () => {} });
const tryEntries = r1.trace.filter((t) => t.path.join('.') === 'try');
console.log('retry: cycles =', tryEntries.map((e) => e.cycle));

// (b) Forward link: link declared before the label.
const forwardFlow = nrail((r) => {
  r.entry('main');
  r.step('X', async () => 'special', 'main', ['main', 'special']);
  r.link('merge', 'special');       // pending: special → merge.in
  r.step('Y', async () => 'main',  'main', 'main');
  r.label('merge', 'main');         // resolves the pending link
});

console.log('forward outputs:', forwardFlow.outputs);
const r2 = await flow('forward', forwardFlow).run({}, { logger: () => {} });
console.log('forward exit  :', r2.exit);
