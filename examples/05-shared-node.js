/**
 * §14.8 — Reusing a node under multiple names.
 *
 * The same atomic-builder instance is added under two local names.
 * Each addition produces an independent position with its own
 * `local` slot; `runInfo.traceEntry.path` distinguishes them.
 */

import { activity, pass, step, flow } from '../rail.js';

const log = pass(async (_ctx, _local, runInfo) => {
  console.log('@', runInfo.traceEntry.path.join('.'));
});

const wf = activity((a) => {
  a.entry('in');
  a.addNode('logIn',  log);
  a.addNode('logOut', log);
  a.addNode('process', step(async (ctx) => { ctx.processed = true; }));
  a.exit('done');

  a.wire('.in',             'logIn.success');
  a.wire('logIn.success',   'process.success');
  a.wire('process.success', 'logOut.success');
  a.wire('process.failure', '.done');
  a.wire('logOut.success',  '.done');
});

await flow('shared', wf).run({});
