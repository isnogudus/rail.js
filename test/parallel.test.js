/**
 * parallel — spec §8. Acceptance §16.8.
 */

import { describe, expect, it } from 'vitest';
import {
  activity, parallel, step, atom, pin, flow,
  RailAggregateError, RailBuildError, RailError, RailRuntimeError,
} from '../rail.js';

const noLog = () => {};

describe('parallel build validation', () => {
  it('produces __rail_kind__: parallel, inputs:[in], outputs:[out] (no merge)', () => {
    const p = parallel({ a: step(async () => {}), b: step(async () => {}) });
    expect(p.__rail_kind__).toBe('parallel');
    expect(p.inputs).toEqual(['in']);
    expect(p.outputs).toEqual(['out']);
  });

  it('rejects non-object branches with TypeError', () => {
    expect(() => parallel('bad')).toThrow(TypeError);
    expect(() => parallel(null)).toThrow(TypeError);
    expect(() => parallel([step(async () => {})])).toThrow(TypeError);
  });

  it('rejects empty branches with MISSING_NODES', () => {
    try {
      parallel({});
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RailBuildError);
      expect(e.code).toBe('MISSING_NODES');
    }
  });

  it('rejects non-rail-node branch with NOT_A_NODE', () => {
    try {
      parallel({ a: { x: 1 } });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('NOT_A_NODE');
    }
  });

  it('rejects multi-input branch with MULTI_INPUT_NODE', () => {
    const multi = atom(async () => 'ok', { inputs: ['a', 'b'], outputs: ['ok'] });
    try {
      parallel({ x: multi });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('MULTI_INPUT_NODE');
    }
  });

  it('rejects __merge__ as a branch name (INVALID_NAME)', () => {
    try {
      parallel({ __merge__: step(async () => {}) });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('INVALID_NAME');
    }
  });

  it('exposes merge node outputs as parallel outputs', () => {
    const merge = atom(async () => 'ok', { outputs: ['ok', 'err'] });
    const p = parallel({ a: step(async () => {}) }, merge);
    expect(p.outputs).toEqual(['ok', 'err']);
  });

  it('rejects multi-input merge with MULTI_INPUT_NODE', () => {
    const merge = atom(async () => 'ok', { inputs: ['a', 'b'], outputs: ['ok'] });
    try {
      parallel({ a: step(async () => {}) }, merge);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('MULTI_INPUT_NODE');
    }
  });
});

describe('parallel runtime', () => {
  it('runs branches concurrently and aggregates branch ctxes', async () => {
    const p = parallel({
      profile: step(async (ctx) => { ctx.profile = 'p:' + ctx.userId; }),
      orders:  step(async (ctx) => { ctx.orders = 'o:' + ctx.userId; }),
    });
    const r = await flow('f', p).run({ userId: 'u-1' }, { logger: noLog });
    expect(r.exit).toBe('out');
    expect(r.ctx.profile).toEqual({ userId: 'u-1', profile: 'p:u-1' });
    expect(r.ctx.orders).toEqual({ userId: 'u-1', orders: 'o:u-1' });
  });

  it('throws RailAggregateError when any branch fails', async () => {
    const p = parallel({
      ok: step(async () => {}),
      bad: atom(async () => { throw new Error('boom'); }, { outputs: ['ok'] }),
    });
    try {
      await flow('f', p).run({}, { logger: noLog });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RailAggregateError);
      expect(e).toBeInstanceOf(RailError);
      expect(e.code).toBe('PARALLEL_BRANCH_FAILED');
      expect(e.flowName).toBe('f');
      expect(Object.keys(e.branchErrors)).toEqual(['bad']);
      expect(e.branchErrors.bad).toBeInstanceOf(RailRuntimeError);
      expect(e.branchErrors.bad.code).toBe('UNHANDLED_THROW');
      expect(Array.isArray(e.errors)).toBe(true);
      expect(e.errors.length).toBe(1);
    }
  });

  it('aggregates multiple branch failures in declaration order', async () => {
    const p = parallel({
      a: atom(async () => { throw new Error('a-err'); }, { outputs: ['ok'] }),
      b: step(async () => {}),
      c: atom(async () => { throw new Error('c-err'); }, { outputs: ['ok'] }),
    });
    try {
      await flow('f', p).run({}, { logger: noLog });
      throw new Error('should have thrown');
    } catch (e) {
      expect(Object.keys(e.branchErrors)).toEqual(['a', 'c']);
    }
  });

  it('runs a merge node when all branches succeed', async () => {
    const merge = atom(async (ctx) => {
      const sum = ctx.a.v + ctx.b.v;
      for (const k of Object.keys(ctx)) delete ctx[k];
      ctx.sum = sum;
      return 'ok';
    }, { outputs: ['ok'] });
    const p = parallel({
      a: step(async (ctx) => { ctx.v = 10; }),
      b: step(async (ctx) => { ctx.v = 20; }),
    }, merge);
    const r = await flow('f', p).run({}, { logger: noLog });
    expect(r.exit).toBe('ok');
    expect(r.ctx).toEqual({ sum: 30 });
  });

  it('skips merge node when any branch fails', async () => {
    let mergeCalled = false;
    const merge = atom(async () => { mergeCalled = true; return 'ok'; }, { outputs: ['ok'] });
    const p = parallel({
      a: atom(async () => { throw new Error('boom'); }, { outputs: ['ok'] }),
      b: step(async () => {}),
    }, merge);
    try { await flow('f', p).run({}, { logger: noLog }); } catch {}
    expect(mergeCalled).toBe(false);
  });

  it('per-branch shallow copy isolates top-level mutations', async () => {
    const p = parallel({
      a: step(async (ctx) => { ctx.shared = 'a-touched'; }),
      b: step(async (ctx) => { ctx.shared = 'b-touched'; }),
    });
    const r = await flow('f', p).run({ shared: 'initial' }, { logger: noLog });
    expect(r.ctx.a.shared).toBe('a-touched');
    expect(r.ctx.b.shared).toBe('b-touched');
  });

  it('aborts sibling branches via combined signal on first failure', async () => {
    let bSawAborted = false;
    const slowB = atom(async (ctx, _local, runInfo) => {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 50);
        runInfo.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); });
      });
      bSawAborted = runInfo.signal.aborted;
      return 'ok';
    }, { outputs: ['ok'] });

    const p = parallel({
      a: atom(async () => { throw new Error('a-fail'); }, { outputs: ['ok'] }),
      b: slowB,
    });
    try { await flow('f', p).run({}, { logger: noLog }); } catch {}
    expect(bSawAborted).toBe(true);
  });
});

describe('parallel inside an activity', () => {
  it('integrates with activity wires', async () => {
    const fan = parallel({
      x: step(async (ctx) => { ctx.x = 1; }),
      y: step(async (ctx) => { ctx.y = 2; }),
    });
    const wf = activity((a) => {
      a.entry('in');
      a.addNode('fan', fan);
      a.exit('done');
      a.wire('.in', 'fan.in');
      a.wire('fan.out', '.done');
    });
    const r = await flow('f', wf).run({}, { logger: noLog });
    expect(r.exit).toBe('done');
    // Branches produce shallow-copied ctxes aggregated under their names.
    expect(r.ctx.x).toEqual({ x: 1 });
    expect(r.ctx.y).toEqual({ y: 2 });
  });
});
