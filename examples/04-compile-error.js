/**
 * §9.4 — Compile error example.
 *
 * Phase B catches incomplete topologies (unwired output, exit not
 * wired). All issues in a phase are collected and reported together.
 */

import { activity, node, RailCompileError } from '../rail.js';

const broken = activity((a) => {
  const start = a.entry('in');
  const { success, failure } = a.standardExits();
  const stepA = a.addNode('a', node(() => 'ok', { outputs: ['ok', 'bad'] }));
  a.wire(start,             stepA);
  a.wire(stepA.out('ok'),   success);
  // 'bad' output is unwired.
  // 'failure' exit has no incoming wire.
});

try {
  broken.compile();
} catch (e) {
  if (e instanceof RailCompileError) {
    console.log(`Phase: ${e.phase}`);
    for (const issue of e.errors) {
      console.log('  -', JSON.stringify(issue));
    }
  } else {
    throw e;
  }
}
