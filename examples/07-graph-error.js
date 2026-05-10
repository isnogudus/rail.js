/**
 * §9.9 — Graph errors propagate as `RailRuntimeError`.
 *
 * A step returning an output not declared on its node is a graph
 * error: the run rejects, no `RunResult` is delivered, and the error
 * carries the trace + ctx.
 *
 * Compare to a domain error, which is just a named output the
 * activity routes via wires.
 */

import { activity, node, flow, RailRuntimeError } from '../rail.js';

const def = activity((a) => {
  const start = a.entry('in');
  const success = a.exit('success');
  const stepNode = a.addNode('step', node(() => 'okk', { outputs: ['ok'] }));
  //                                                  ^^^ typo on purpose
  a.wire(start, stepNode);
  a.wire(stepNode.out('ok'), success);
});
def.compile();

try {
  await flow('typo', def).run({}, { logger: () => {} });
} catch (e) {
  if (e instanceof RailRuntimeError) {
    console.log('Caught RailRuntimeError:');
    console.log('  code:', e.code);
    console.log('  flow:', e.flow);
    console.log('  trace length:', e.trace.length);
    console.log('  last trace entry:', e.trace[e.trace.length - 1]);
  } else {
    throw e;
  }
}
