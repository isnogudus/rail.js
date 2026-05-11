import { describe, it, expect } from 'vitest';
import {
  activity,
  node,
  parallel,
  flow,
  isParallelCtx,
  RailCheckError,
  RailRuntimeError,
} from '../rail.js';

const silent = { logger: () => {} };

describe('parallel(branches) (§3.7)', () => {
  it('runs all branches and produces parallel-results ctx', async () => {
    const ba = activity((a) => {
      const s = a.entry('in');
      const ok = a.exit('ok');
      const f = a.addNode('f', node((c) => ({ output: 'ok', ctx: { ...c, a: 'A' } }),
        { outputs: ['ok'] }));
      a.wire(s, f);
      a.wire(f.out('ok'), ok);
    });
    const bb = activity((a) => {
      const s = a.entry('in');
      const ok = a.exit('ok');
      const f = a.addNode('f', node((c) => ({ output: 'ok', ctx: { ...c, b: 'B' } }),
        { outputs: ['ok'] }));
      a.wire(s, f);
      a.wire(f.out('ok'), ok);
    });

    const par = parallel({ a: ba, b: bb });

    const wf = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const fan = a.addNode('fan', par);
      const eval_ = a.addNode('eval', node((c) => {
        return { output: 'ok', ctx: c };
      }, { outputs: ['ok'] }));
      a.wire(start, fan);
      a.wire(fan.out('done'), eval_);
      a.wire(eval_.out('ok'), ok);
    });
    wf.check();

    const r = await flow('wf', wf).run({ seed: 1 }, silent);
    expect(r.terminus).toBe('ok');
    expect(isParallelCtx(r.ctx)).toBe(true);
    expect(r.ctx.inputCtx).toEqual({ seed: 1 });
    expect(r.ctx.results.a.terminus).toBe('ok');
    expect(r.ctx.results.a.ctx).toEqual({ seed: 1, a: 'A' });
    expect(r.ctx.results.b.terminus).toBe('ok');
    expect(r.ctx.results.b.ctx).toEqual({ seed: 1, b: 'B' });
  });

  it('first error in branch declaration order is re-thrown', async () => {
    const fast = node(async () => {
      throw new Error('fast');
    }, { outputs: ['ok'] });
    const slow = node(async () => {
      await new Promise((r) => setTimeout(r, 5));
      throw new Error('slow');
    }, { outputs: ['ok'] });

    const par = parallel({ first: fast, second: slow });
    const wf = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const fan = a.addNode('fan', par);
      a.wire(start, fan);
      a.wire(fan.out('done'), ok);
    });
    wf.check();

    try {
      await flow('wf', wf).run({}, silent);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RailRuntimeError);
      // Both branches throw; `first` is declared first and is the one re-thrown.
      expect(e.cause?.message).toBe('fast');
    }
  });

  it('branch-level structural error surfaces at outer compile time (acceptance #3)', () => {
    const broken = activity((a) => {
      a.entry('in');
      a.exit('ok'); // exit not wired
    });
    const par = parallel({ b: broken });
    const wf = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const fan = a.addNode('fan', par);
      a.wire(start, fan);
      a.wire(fan.out('done'), ok);
    });
    expect(() => wf.check()).toThrow(RailCheckError);
  });

  it('compound branch trace entries use parallelName.branchKey form (acceptance #34)', async () => {
    const ba = activity((a) => {
      const s = a.entry('in');
      const ok = a.exit('ok');
      const v = a.addNode('validate', node(() => 'ok', { outputs: ['ok'] }));
      a.wire(s, v);
      a.wire(v.out('ok'), ok);
    });
    const par = parallel({ branchA: ba });
    const wf = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const fan = a.addNode('fan', par);
      const merge = a.addNode('merge', node(() => 'ok', { outputs: ['ok'] }));
      a.wire(start, fan);
      a.wire(fan.out('done'), merge);
      a.wire(merge.out('ok'), ok);
    });
    wf.check();

    const r = await flow('wf', wf).run({}, silent);
    const stepNames = r.trace.map((e) => e.step);
    expect(stepNames).toContain('fan.branchA.validate');
    expect(stepNames).toContain('fan.branchA');
    expect(stepNames).toContain('fan');
  });

  it('inner steps inside a parallel Activity branch carry depth=1 (acceptance #25)', async () => {
    const inner = activity((a) => {
      const s = a.entry('in');
      const ok = a.exit('ok');
      const x = a.addNode('x', node(() => 'ok', { outputs: ['ok'] }));
      a.wire(s, x);
      a.wire(x.out('ok'), ok);
    });
    const par = parallel({ b: inner });
    const wf = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const fan = a.addNode('fan', par);
      a.wire(start, fan);
      a.wire(fan.out('done'), ok);
    });
    wf.check();

    const r = await flow('wf', wf).run({}, silent);
    const xEntry = r.trace.find((e) => e.step === 'fan.b.x');
    const fanBEntry = r.trace.find((e) => e.step === 'fan.b');
    const fanEntry = r.trace.find((e) => e.step === 'fan');
    expect(xEntry?.depth).toBe(1);
    expect(fanBEntry?.depth).toBe(0);
    expect(fanEntry?.depth).toBe(0);
  });
});
