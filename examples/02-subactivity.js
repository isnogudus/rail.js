/**
 * §14.3 — Sub-activity composition.
 *
 * A reusable validation activity used twice in the same parent
 * under different local names (independent positions, independent
 * locals).
 */

import { activity, atom, flow } from '../rail.js';

const validate = activity((a) => {
  a.entry('in');
  a.addNode('check', atom(async (ctx) => {
    if (ctx.value == null) {
      ctx.reason = 'missing';
      return 'bad';
    }
    return 'ok';
  }, { outputs: ['ok', 'bad'] }));
  a.exit('ok');
  a.exit('bad');
  a.wire('.in',       'check.in');
  a.wire('check.ok',  '.ok');
  a.wire('check.bad', '.bad');
});

const twoStage = activity((a) => {
  a.entry('in');
  a.addNode('v1', validate);
  a.addNode('v2', validate);
  a.exit('done');
  a.exit('rejected');
  a.wire('.in',     'v1.in');
  a.wire('v1.ok',   'v2.in');
  a.wire('v1.bad',  '.rejected');
  a.wire('v2.ok',   '.done');
  a.wire('v2.bad',  '.rejected');
});

const r1 = await flow('two-stage', twoStage).run({ value: 42 });
console.log('value=42  →', r1.exit);

const r2 = await flow('two-stage', twoStage).run({});
console.log('no value  →', r2.exit, r2.ctx.reason);
