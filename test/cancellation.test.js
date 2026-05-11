import { describe, it, expect } from 'vitest';
import { activity, node, flow, RailRuntimeError } from '../rail.js';

const silent = { logger: () => {} };

describe('Cancellation: signal + killSignal (§6.7, acceptance #23, #24)', () => {
  it('opts.signal is exposed as runInfo.signal (cooperative)', async () => {
    let captured;
    const f = node((_c, _l, ri) => { captured = ri.signal; return 'ok'; },
      { outputs: ['ok'] });
    f.check();
    const ctrl = new AbortController();
    await flow('s', f).run({}, { ...silent, signal: ctrl.signal });
    expect(captured).toBe(ctrl.signal);
  });

  it('cooperative cancellation: step observes signal and yields to a "cancelled" exit (§9.10)', async () => {
    const ctrl = new AbortController();

    const validate = node(() => 'ok', { outputs: ['ok'] });
    const send = node(async (_c, _l, ri) => {
      // Wait until aborted, then return cancelled.
      while (!ri.signal?.aborted) await new Promise((r) => setTimeout(r, 1));
      return 'cancelled';
    }, { outputs: ['ok', 'cancelled'] });

    const upload = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const cancelled = a.exit('cancelled');
      const v = a.addNode('validate', validate);
      const s = a.addNode('send', send);
      a.wire(start, v);
      a.wire(v.out('ok'), s);
      a.wire(s.out('ok'), ok);
      a.wire(s.out('cancelled'), cancelled);
    });
    upload.check();

    const promise = flow('upload', upload).run({}, { ...silent, signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 5);
    const r = await promise;
    expect(r.terminus).toBe('cancelled');
  });

  it('killSignal aborts the run with KILLED before next node', async () => {
    const kill = new AbortController();
    let secondInvoked = false;
    const a = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const first = a.addNode('first', node(() => {
        kill.abort(); // Trigger kill from inside the first step.
        return 'ok';
      }, { outputs: ['ok'] }));
      const second = a.addNode('second', node(() => {
        secondInvoked = true;
        return 'ok';
      }, { outputs: ['ok'] }));
      a.wire(start, first);
      a.wire(first.out('ok'), second);
      a.wire(second.out('ok'), ok);
    });
    a.check();

    try {
      await flow('a', a).run({}, { ...silent, killSignal: kill.signal });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RailRuntimeError);
      expect(e.code).toBe('KILLED');
      expect(e.flow).toBe('a');
      expect(secondInvoked).toBe(false);
    }
  });

  it('combined signal: signal + killSignal aborts on either', async () => {
    const userSignal = new AbortController();
    const killSignal = new AbortController();
    let combined;
    const a = node((_c, _l, ri) => { combined = ri.signal; return 'ok'; },
      { outputs: ['ok'] });
    a.check();

    await flow('a', a).run({}, { ...silent, signal: userSignal.signal, killSignal: killSignal.signal });
    expect(combined.aborted).toBe(false);
    userSignal.abort();
    expect(combined.aborted).toBe(true);
  });

  it('STEP_LIMIT_EXCEEDED when sub-activities would exceed maxSteps (acceptance #24)', async () => {
    const inner = activity((a) => {
      const s = a.entry('in');
      const ok = a.exit('ok');
      const x = a.addNode('x', node(() => 'ok', { outputs: ['ok'] }));
      a.wire(s, x);
      a.wire(x.out('ok'), ok);
    });
    const outer = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const i1 = a.addNode('i1', inner);
      const i2 = a.addNode('i2', inner); // same instance
      a.wire(start, i1);
      a.wire(i1.out('ok'), i2);
      a.wire(i2.out('ok'), ok);
    });
    outer.check();

    // Outer steps: i1 (compound), i2 (compound) = 2 outer steps
    // Inner steps inside each: x = 1 inner step per
    // Plus 1 for the top-level activity invocation by flow.run
    // ≈ 5+ steps total. maxSteps=2 should fail.
    try {
      await flow('o', outer).run({}, { ...silent, maxSteps: 2 });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RailRuntimeError);
      expect(e.code).toBe('STEP_LIMIT_EXCEEDED');
    }
  });
});
