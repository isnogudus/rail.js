/**
 * §14.10 — Cooperative cancellation via `opts.signal`.
 *
 * Two abort channels are available:
 *   - opts.signal:     cooperative — runs to a clean exit if a step
 *                      observes the signal and routes accordingly.
 *   - opts.killSignal: enforcing — `invokeNode` aborts at the next
 *                      node boundary with RailRuntimeError(KILLED).
 */

import { activity, step, flow, RailRuntimeError } from '../rail.js';

const longRunner = step(async (_ctx, _local, runInfo) => {
  for (let i = 0; i < 1_000_000; i++) {
    if (runInfo.signal.aborted) {
      throw new DOMException('aborted', 'AbortError');
    }
    await new Promise((r) => setTimeout(r, 1));
  }
});

const cancellable = activity((a) => {
  a.entry('in');
  a.addNode('long', longRunner);
  a.exit('done');
  a.exit('aborted');
  a.wire('.in',          'long.success');
  a.wire('long.success', '.done');
  a.wire('long.failure', '.aborted');
});

// Cooperative path: the step catches the AbortError and routes to failure.
{
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 30);
  const r = await flow('cancellable', cancellable).run({}, { signal: ctrl.signal });
  console.log('cooperative →', r.exit, r.ctx._error?.name);
}

// Enforcing path: killSignal aborts at the next node boundary.
{
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 30);
  try {
    await flow('cancellable', cancellable).run({}, { killSignal: ctrl.signal });
  } catch (err) {
    if (err instanceof RailRuntimeError) {
      console.log('enforcing  →', err.code);
    }
  }
}
