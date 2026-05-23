/**
 * §8 / §12.4 — `RailAggregateError` from `parallel(...)`.
 *
 * Every branch rejection — including the single-rejection case — is
 * delivered as a `RailAggregateError`. The aggregate carries
 * `branchErrors` keyed by branch name (declaration order) and
 * exposes `errors[]` as a derived flat view. When any branch
 * rejects, sibling branches see `runInfo.signal.aborted === true`
 * and may exit cooperatively.
 */

import { parallel, atom, step, flow, RailAggregateError } from '../rail.js';

let bWasAborted = false;
const slowB = atom(async (_ctx, _local, runInfo) => {
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 50);
    runInfo.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); });
  });
  bWasAborted = runInfo.signal.aborted;
  return 'ok';
}, { outputs: ['ok'] });

const fan = parallel({
  good:    step(async (ctx) => { ctx.good = true; }),
  fastBad: atom(async () => { throw new Error('boom-fast'); }, { outputs: ['ok'] }),
  slow:    slowB,
});

try {
  await flow('fan', fan).run({}, { logger: () => {} });
} catch (err) {
  if (err instanceof RailAggregateError) {
    console.log('code         :', err.code);
    console.log('flowName     :', err.flowName);
    console.log('branchErrors :', Object.fromEntries(
      Object.entries(err.branchErrors).map(([k, e]) => [k, `${e.code} (${e.cause?.message ?? e.message})`]),
    ));
    console.log('errors[].len :', err.errors.length);
    console.log('sibling aborted cooperatively:', bWasAborted);
  } else {
    throw err;
  }
}
