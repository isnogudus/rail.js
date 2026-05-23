/**
 * §14.12 — Tracer events.
 *
 * A tracer receives `(entry, event)` pairs where `event` is
 * 'begin' or 'end'. A clean run pairs every 'begin' with one 'end'.
 * Wrappers (pin) are trace-transparent and emit nothing.
 */

import { activity, step, flow } from '../rail.js';

const wf = activity((a) => {
  a.entry('in');
  a.addNode('a', step(async () => {}));
  a.addNode('b', step(async () => {}));
  a.exit('done');
  a.wire('.in', 'a.success');
  a.wire('a.success', 'b.success');
  a.wire('a.failure', '.done');
  a.wire('b.success', '.done');
  a.wire('b.failure', '.done');
});

const events = [];
await flow('traced', wf).run({}, {
  logger: () => {},
  tracer: (entry, event) => {
    events.push(`${event.padEnd(6)} ${entry.kind.padEnd(10)} path=[${entry.path.join('.')}] cycle=${entry.cycle}`);
  },
});

for (const ev of events) console.log(ev);
