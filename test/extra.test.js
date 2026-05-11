/**
 * Extra acceptance tests:
 *   - merge helper (§3.8)
 *   - per-fork run-state isolation in interleaved parallel branches (#33)
 *   - flow stateless reentrancy / tracer-can-start-new-runs (#32)
 *   - signal-only / killSignal-only / both combinations (#23)
 *   - reentrant compile() (#20)
 */

import { describe, it, expect } from 'vitest';
import {
  activity,
  node,
  merge,
  parallel,
  flow,
  isParallelCtx,
} from '../rail.js';

const silent = { logger: () => {} };

describe('merge(stepFn) (§3.8)', () => {
  it('preserves input ctx and shallow-merges patch', async () => {
    const m = merge((c) => ({ output: 'ok', patch: { x: c.x + 1 } }));
    const s = node(m, { outputs: ['ok'] });
    s.check();
    const r = await flow('m', s).run({ x: 1, y: 'keep' }, silent);
    expect(r.ctx).toEqual({ x: 2, y: 'keep' });
  });

  it('string return forwarded as-is', async () => {
    const m = merge(() => 'ok');
    const s = node(m, { outputs: ['ok'] });
    s.check();
    const r = await flow('m', s).run({ y: 'keep' }, silent);
    expect(r.ctx).toEqual({ y: 'keep' });
    expect(r.terminus).toBe('ok');
  });

  it('object without patch leaves ctx unchanged', async () => {
    const m = merge(() => ({ output: 'ok' }));
    const s = node(m, { outputs: ['ok'] });
    s.check();
    const r = await flow('m', s).run({ y: 'keep' }, silent);
    expect(r.ctx).toEqual({ y: 'keep' });
  });
});

describe('Per-fork run-state isolation (#33)', () => {
  it('two interleaved parallel Activity branches do not trample each others depth/currentInput', async () => {
    const aDepths = [];
    const bDepths = [];

    const branchA = activity((a) => {
      const s = a.entry('in');
      const ok = a.exit('ok');
      const x = a.addNode('x', node(async (_c, _l, ri) => {
        aDepths.push(ri.input);
        await new Promise((r) => setTimeout(r, 5));
        return 'ok';
      }, { outputs: ['ok'] }));
      a.wire(s, x);
      a.wire(x.out('ok'), ok);
    });
    const branchB = activity((a) => {
      const s = a.entry('in');
      const ok = a.exit('ok');
      const y = a.addNode('y', node(async (_c, _l, ri) => {
        bDepths.push(ri.input);
        await new Promise((r) => setTimeout(r, 5));
        return 'ok';
      }, { outputs: ['ok'] }));
      a.wire(s, y);
      a.wire(y.out('ok'), ok);
    });
    const par = parallel({ a: branchA, b: branchB });
    const wf = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const fan = a.addNode('fan', par);
      a.wire(start, fan);
      a.wire(fan.out('done'), ok);
    });
    wf.check();

    const events = [];
    const r = await flow('w', wf).run({}, {
      ...silent,
      tracer: (e) => events.push(e),
    });
    expect(r.terminus).toBe('ok');

    // Each branch's inner step runs at depth=1 (per acceptance #33).
    const xEnd = events.find((e) => e.type === 'step-end' && e.step === 'fan.a.x');
    const yEnd = events.find((e) => e.type === 'step-end' && e.step === 'fan.b.y');
    expect(xEnd.depth).toBe(1);
    expect(yEnd.depth).toBe(1);
    // Each branch saw its own input ('in').
    expect(aDepths).toEqual(['in']);
    expect(bDepths).toEqual(['in']);
  });
});

describe('Stateless flow + reentrancy (#32)', () => {
  it('tracer may start a new flow run during event handling', async () => {
    const inner = activity((a) => {
      const s = a.entry('in');
      const ok = a.exit('ok');
      const x = a.addNode('x', node(() => 'ok', { outputs: ['ok'] }));
      a.wire(s, x);
      a.wire(x.out('ok'), ok);
    });
    inner.check();
    const innerFlow = flow('inner', inner);

    const outer = activity((a) => {
      const s = a.entry('in');
      const ok = a.exit('ok');
      const y = a.addNode('y', node(() => 'ok', { outputs: ['ok'] }));
      a.wire(s, y);
      a.wire(y.out('ok'), ok);
    });
    outer.check();

    let inSubRunCalled = false;
    const tracer = (e) => {
      if (e.type === 'step-start' && e.step === 'y' && !inSubRunCalled) {
        inSubRunCalled = true;
        // Synchronously kick off another run (it runs concurrently with the outer).
        innerFlow.run({}, silent);
      }
    };

    const r = await flow('outer', outer).run({}, { ...silent, tracer });
    expect(r.terminus).toBe('ok');
    expect(inSubRunCalled).toBe(true);
  });
});

describe('Signal combinations (#23)', () => {
  it('neither signal: runInfo.signal is undefined', async () => {
    let captured;
    const s = node((_c, _l, ri) => { captured = ri.signal; return 'ok'; },
      { outputs: ['ok'] });
    s.check();
    await flow('s', s).run({}, silent);
    expect(captured).toBeUndefined();
  });

  it('signal only: runInfo.signal is opts.signal', async () => {
    const ctrl = new AbortController();
    let captured;
    const s = node((_c, _l, ri) => { captured = ri.signal; return 'ok'; },
      { outputs: ['ok'] });
    s.check();
    await flow('s', s).run({}, { ...silent, signal: ctrl.signal });
    expect(captured).toBe(ctrl.signal);
  });

  it('killSignal only: runInfo.signal is a derived signal', async () => {
    const kill = new AbortController();
    let captured;
    const s = node((_c, _l, ri) => { captured = ri.signal; return 'ok'; },
      { outputs: ['ok'] });
    s.check();
    await flow('s', s).run({}, { ...silent, killSignal: kill.signal });
    expect(captured).toBe(kill.signal); // single-signal pass-through
  });
});

describe('Sub-activity ctx replacement (§8.2)', () => {
  it('outer running ctx is replaced by sub-activitys final ctx', async () => {
    const inner = activity((a) => {
      const s = a.entry('in');
      const ok = a.exit('ok');
      const x = a.addNode('x', node(
        (c) => ({ output: 'ok', ctx: { fromInner: true } }),
        { outputs: ['ok'] }
      ));
      a.wire(s, x);
      a.wire(x.out('ok'), ok);
    });
    const outer = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const i = a.addNode('inner', inner);
      const after = a.addNode('after', node(
        (c) => ({ output: 'ok', ctx: { ...c, fromOuter: true } }),
        { outputs: ['ok'] }
      ));
      a.wire(start, i);
      a.wire(i.out('ok'), after);
      a.wire(after.out('ok'), ok);
    });
    outer.check();

    const r = await flow('o', outer).run({ origin: true }, silent);
    expect(r.ctx.fromInner).toBe(true);
    expect(r.ctx.fromOuter).toBe(true);
    // ctx replacement is total — origin is gone after inner returns.
    expect(r.ctx.origin).toBeUndefined();
  });
});

describe('Trace entry shape (§3.6)', () => {
  it('successful step entry has step / output / duration / depth / threw=false', async () => {
    const s = node(() => 'ok', { outputs: ['ok'] });
    const a = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const v = a.addNode('v', s);
      a.wire(start, v);
      a.wire(v.out('ok'), ok);
    });
    a.check();
    const r = await flow('w', a).run({}, silent);
    const entry = r.trace[0];
    expect(entry.step).toBe('v');
    expect(entry.output).toBe('ok');
    expect(typeof entry.duration).toBe('number');
    expect(entry.depth).toBe(0);
    expect(entry.threw).toBe(false);
  });
});
