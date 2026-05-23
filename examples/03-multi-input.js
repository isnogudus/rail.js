/**
 * Multi-entry sub-activity used through two pins.
 *
 * The same inner activity is registered twice under different
 * local names via `pin(node, entry)`, so each pin position has
 * its own local slot — the inner counter is independent at each
 * position.
 */

import { activity, atom, flow, pin } from '../rail.js';

const multi = activity((a) => {
  a.entry('fromCache', 'fromAPI');
  a.addNode('record', atom(async (ctx, local, runInfo) => {
    local.calls = (local.calls ?? 0) + 1;
    ctx.history ??= [];
    ctx.history.push({ entry: runInfo.traceEntry.entry, calls: local.calls });
    return 'ok';
  }, { outputs: ['ok'] }));
  a.exit('done');
  a.wire('.fromCache', 'record.in');
  a.wire('.fromAPI',   'record.in');
  a.wire('record.ok',  '.done');
});

const wf = activity((a) => {
  a.entry('in');
  a.addNode('viaCache', pin(multi, 'fromCache'));
  a.addNode('viaAPI',   pin(multi, 'fromAPI'));
  a.exit('done');
  a.wire('.in',           'viaCache.in');
  a.wire('viaCache.done', 'viaAPI.in');
  a.wire('viaAPI.done',   '.done');
});

const r = await flow('multi-pin', wf).run({});
console.log('history:', r.ctx.history);
