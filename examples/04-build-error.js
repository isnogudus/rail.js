/**
 * §14.4 — Build-time validation errors.
 *
 * Every built-in builder validates eagerly. Mistakes raise
 * `RailBuildError` from the offending builder call.
 */

import { activity, step, RailBuildError, RailError } from '../rail.js';

try {
  activity((a) => {
    a.entry('in');
    a.addNode('work', step(async () => {}));
    a.exit('done');
    a.wire('.in', 'work.success');
    // Forgot: a.wire('work.success', '.done');
    // Forgot: a.wire('work.failure', '.done');
  });
} catch (err) {
  if (err instanceof RailError) {
    console.log('caught:', err.constructor.name);
    console.log('code  :', err.code);
    console.log('msg   :', err.message);
  } else {
    throw err;
  }
}
