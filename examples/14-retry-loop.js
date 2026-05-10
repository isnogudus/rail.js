/**
 * Retry pattern — multi-input convergence + bounded retries.
 *
 * The graph fans an `op` step's `failed` output through a `decide`
 * node that either retries (looping back to op via the 'retry'
 * input) or gives up (routing to the failure exit). The retry
 * counter lives in the ctx; the library does not introduce hidden
 * state.
 */

import { activity, node, flow } from '../rail.js';

const wf = activity((a) => {
  const start = a.entry('in');
  const { success, failure } = a.standardExits();

  const op = a.addNode('op', node(async (ctx) => {
    // Simulate flakiness: succeed on the 3rd attempt.
    const attempt = (ctx.attempt ?? 0) + 1;
    if (attempt < 3) {
      return { output: 'failed', ctx: { ...ctx, attempt, lastError: 'flaky' } };
    }
    return { output: 'ok', ctx: { ...ctx, attempt, result: 'all good' } };
  }, { inputs: ['fresh', 'retry'], outputs: ['ok', 'failed'] }));

  const decide = a.addNode('decide', node((ctx) => {
    if ((ctx.attempt ?? 0) >= 5) return 'give-up';
    return 'retry';
  }, { outputs: ['retry', 'give-up'] }));

  a.wire(start,              op.in('fresh'));
  a.wire(op.out('ok'),       success);
  a.wire(op.out('failed'),   decide);
  a.wire(decide.out('retry'), op.in('retry'));
  a.wire(decide.out('give-up'), failure);
});

// Phase C will reject this graph: it contains a CYCLE by design.
// This example exists to demonstrate that compile() catches the
// cycle — cycles are out of scope for v1 (§13).
import { RailCompileError } from '../rail.js';
try {
  wf.compile();
} catch (e) {
  if (e instanceof RailCompileError && e.phase === 'topology') {
    console.log('Compile rejected the retry loop (as expected — cycles are §13 future work):');
    for (const issue of e.errors) console.log('  -', JSON.stringify(issue));
  } else {
    throw e;
  }
}

console.log('\nPattern that DOES compile: bounded unrolling, e.g. attempt1 → attempt2 → attempt3.');
console.log('Or: keep the retry loop INSIDE a single Step-Node, exposing only one outcome to the graph.');

// Demonstration: retry loop encapsulated in a step.
const retryStep = node(async (ctx) => {
  for (let i = 1; i <= 5; i++) {
    if (i >= 3) return { output: 'ok', ctx: { ...ctx, attempts: i, result: 'all good' } };
  }
  return { output: 'failed', ctx };
}, { outputs: ['ok', 'failed'] });

const wf2 = activity((a) => {
  const start = a.entry('in');
  const { success, failure } = a.standardExits();
  const op = a.addNode('op', retryStep);
  a.wire(start, op);
  a.wire(op.out('ok'), success);
  a.wire(op.out('failed'), failure);
});
wf2.compile();

const r = await flow('wf2', wf2).run({}, { logger: () => {} });
console.log('\nencapsulated-retry terminus:', r.terminus, '— attempts:', r.ctx.attempts);
