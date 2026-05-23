/**
 * §14.9 — Library throw vs domain outcome.
 *
 * An uncaught throw out of an `atom` becomes a library error
 * (RailRuntimeError with code UNHANDLED_THROW) and propagates out
 * of `flow.run`. A `step` would catch the same throw and route it
 * to 'failure' as a domain outcome instead.
 */

import { activity, atom, flow, RailRuntimeError } from '../rail.js';

const broken = activity((a) => {
  a.entry('in');
  a.addNode('boom', atom(async () => { throw new Error('explode'); }, { outputs: ['ok'] }));
  a.exit('done');
  a.wire('.in', 'boom.in');
  a.wire('boom.ok', '.done');
});

try {
  await flow('boom-flow', broken).run({});
} catch (err) {
  if (err instanceof RailRuntimeError) {
    console.log('code  :', err.code);
    console.log('flow  :', err.flowName);
    console.log('cause :', err.cause?.message);
  } else {
    throw err;
  }
}
