/**
 * §9.12 — Live tracer for structured run observation.
 *
 * Pass a function `(event: TracerEvent) => void` as `opts.tracer`
 * to receive lifecycle events at fine granularity:
 *
 *   - run-start, run-end, run-error
 *   - step-start, step-end, step-throw
 *   - activity-enter, activity-leave, activity-throw
 *   - branch-start, branch-end, branch-throw
 *
 * Useful for live UIs (forward to a BroadcastChannel / WebSocket /
 * postMessage), distributed tracing, or recording detailed run
 * histories. Each lifecycle scope emits exactly one start and one
 * end event.
 */

import { activity, node, parallel, flow } from '../rail.js';

const branchA = activity((a) => {
  const s = a.entry('in');
  const ok = a.exit('ok');
  const v = a.addNode('validate', node(() => 'ok', { outputs: ['ok'] }));
  a.wire(s, v);
  a.wire(v.out('ok'), ok);
});

const wf = activity((a) => {
  const start = a.entry('in');
  const ok = a.exit('ok');
  const fan = a.addNode('fan', parallel({ a: branchA }));
  const finish = a.addNode('finish', node(() => 'ok', { outputs: ['ok'] }));
  a.wire(start, fan);
  a.wire(fan.out('done'), finish);
  a.wire(finish.out('ok'), ok);
});
wf.check();

const events = [];
await flow('wf', wf).run({}, {
  logger: () => {},
  tracer: (e) => events.push(e),
});

// Print a summary of the event sequence.
for (const e of events) {
  const indent = '  '.repeat(e.depth);
  switch (e.type) {
    case 'run-start':       console.log(`${indent}> run-start [${e.name}]`); break;
    case 'run-end':         console.log(`${indent}< run-end -> ${e.terminus}`); break;
    case 'run-error':       console.log(`${indent}! run-error: ${e.error.code}`); break;
    case 'step-start':      console.log(`${indent}> step ${e.step} (kind=${e.kind})`); break;
    case 'step-end':        console.log(`${indent}< step ${e.step} -> ${e.output}`); break;
    case 'step-throw':      console.log(`${indent}! step ${e.step} threw: ${e.error?.message}`); break;
    case 'activity-enter':  console.log(`${indent}>> activity-enter ${e.name}`); break;
    case 'activity-leave':  console.log(`${indent}<< activity-leave ${e.name} -> ${e.output}`); break;
    case 'activity-throw':  console.log(`${indent}!! activity-throw ${e.name}: ${e.error?.code}`); break;
    case 'branch-start':    console.log(`${indent}>> branch-start ${e.branch}`); break;
    case 'branch-end':      console.log(`${indent}<< branch-end ${e.branch} -> ${e.output}`); break;
    case 'branch-throw':    console.log(`${indent}!! branch-throw ${e.branch}: ${e.error?.code}`); break;
  }
}
