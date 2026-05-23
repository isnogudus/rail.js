/**
 * Integration tests — full scenarios from the spec §14.
 */

import { describe, expect, it } from 'vitest';
import {
  activity, nrail, railway, parallel, pin, flow,
  atom, nstep, step, pass, fail, catchTo,
  RailError, RailRuntimeError,
} from '../rail.js';

const noLog = () => {};

describe('integration', () => {
  it('§14.1 minimal happy path', async () => {
    const validateEmail = atom(async (ctx) => {
      if (typeof ctx.email === 'string' && ctx.email.includes('@')) return 'ok';
      ctx.reason = 'invalid email';
      return 'bad';
    }, { outputs: ['ok', 'bad'] });

    const wf = activity((a) => {
      a.entry('in');
      a.addNode('check', validateEmail);
      a.exit('success');
      a.exit('failure');
      a.wire('.in',         'check.in');
      a.wire('check.ok',    '.success');
      a.wire('check.bad',   '.failure');
    });

    const r = await flow('validate-only', wf).run({ email: 'me@example.com' }, { logger: noLog });
    expect(r.exit).toBe('success');
    expect(r.ctx.email).toBe('me@example.com');
    expect(r.trace.length).toBeGreaterThan(0);
  });

  it('§14.13 retry with local', async () => {
    let calls = 0;
    const fetchWithRetry = atom(async (ctx, local) => {
      local.attempts ??= 0;
      local.attempts++;
      calls++;
      if (calls < 3) return 'retry';
      ctx.data = 'OK';
      return 'ok';
    }, { outputs: ['ok', 'retry', 'giveUp'] });

    const retrier = activity((a) => {
      a.entry('in');
      a.addNode('fetch', fetchWithRetry);
      a.exit('done');
      a.exit('failed');
      a.wire('.in',           'fetch.in');
      a.wire('fetch.ok',      '.done');
      a.wire('fetch.retry',   'fetch.in');
      a.wire('fetch.giveUp',  '.failed');
    });

    const r = await flow('retrier', retrier).run({}, { logger: noLog });
    expect(r.exit).toBe('done');
    expect(r.ctx.data).toBe('OK');
    // The same position has cycle=3 by the last entry.
    const fetchEntries = r.trace.filter((t) => t.path.join('.') === 'fetch');
    expect(fetchEntries.map((e) => e.cycle)).toEqual([1, 2, 3]);
  });

  it('parallel with merge produces domain-shaped ctx', async () => {
    const mergeResults = atom(async (ctx) => {
      const userId  = ctx.profile.userId;
      const profile = ctx.profile.profile;
      const orders  = ctx.orders.orders;
      for (const k of Object.keys(ctx)) delete ctx[k];
      ctx.userId = userId;
      ctx.profile = profile;
      ctx.orders = orders;
      return 'out';
    }, { outputs: ['out'] });

    const enrich = parallel({
      profile: step(async (ctx) => { ctx.profile = 'P-' + ctx.userId; }),
      orders:  step(async (ctx) => { ctx.orders  = 'O-' + ctx.userId; }),
    }, mergeResults);

    const r = await flow('enrich', enrich).run({ userId: 'u1' }, { logger: noLog });
    expect(r.exit).toBe('out');
    expect(r.ctx).toEqual({ userId: 'u1', profile: 'P-u1', orders: 'O-u1' });
  });

  it('nrail with cleanup chain converges fail rail', async () => {
    let cleaned = 0;
    const wf = nrail((r) => {
      r.entry('main');
      r.step('validate', catchTo(async (ctx) => {
        if (!ctx.ok) throw new Error('bad');
        return 'main';
      }, 'fail'), 'main', ['main', 'fail']);
      r.step('charge', catchTo(async (ctx) => {
        ctx.charged = true;
        return 'main';
      }, 'fail'), 'main', ['main', 'fail']);
      r.step('cleanup', async (ctx) => { ctx.cleaned = ++cleaned; }, 'fail', 'fail');
    });
    expect(wf.outputs).toEqual(['main', 'fail']);

    const ok = await flow('p', wf).run({ ok: true }, { logger: noLog });
    expect(ok.exit).toBe('main');
    expect(ok.ctx.charged).toBe(true);

    const bad = await flow('p', wf).run({ ok: false }, { logger: noLog });
    expect(bad.exit).toBe('fail');
    expect(bad.ctx.cleaned).toBe(1);
  });

  it('railway with mixed step/pass/fail', async () => {
    const wf = railway((r) => {
      r.step('a', async (ctx) => { ctx.a = 1; });
      r.pass('logA', async (ctx) => { ctx.loggedA = true; });
      r.step('b', async () => { throw new Error('b-fails'); });
      r.fail('cleanup', async (ctx) => { ctx.cleanedUp = true; });
    });
    const r = await flow('rw', wf).run({}, { logger: noLog });
    expect(r.exit).toBe('failure');
    expect(r.ctx.a).toBe(1);
    expect(r.ctx.loggedA).toBe(true);
    expect(r.ctx.cleanedUp).toBe(true);
    expect(r.ctx._error.message).toBe('b-fails');
  });

  it('multi-entry inner activity used with two different pins gets independent locals', async () => {
    const inner = activity((a) => {
      a.entry('start');
      a.addNode('count', atom(async (_ctx, local) => {
        local.n = (local.n ?? 0) + 1;
        return 'ok';
      }, { outputs: ['ok'] }));
      a.exit('done');
      a.wire('.start', 'count.in');
      a.wire('count.ok', '.done');
    });
    const outer = activity((a) => {
      a.entry('in');
      a.addNode('p1', pin(inner, 'start'));
      a.addNode('p2', pin(inner, 'start'));
      a.exit('done');
      a.wire('.in', 'p1.in');
      a.wire('p1.done', 'p2.in');
      a.wire('p2.done', '.done');
    });
    const r = await flow('f', outer).run({}, { logger: noLog });
    expect(r.exit).toBe('done');
    // Each pin position has cycle=1 for its inner 'count'.
    const countEntries = r.trace.filter((t) => t.path[t.path.length - 1] === 'count');
    expect(countEntries.length).toBe(2);
    expect(countEntries.map((e) => e.cycle)).toEqual([1, 1]);
  });

  it('uncaught throw out of an atom becomes RailRuntimeError(UNHANDLED_THROW)', async () => {
    const wf = activity((a) => {
      a.entry('in');
      a.addNode('boom', atom(async () => { throw new Error('boom'); }, { outputs: ['ok'] }));
      a.exit('done');
      a.wire('.in', 'boom.in');
      a.wire('boom.ok', '.done');
    });
    try {
      await flow('f', wf).run({}, { logger: noLog });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RailRuntimeError);
      expect(e.code).toBe('UNHANDLED_THROW');
      expect(e.flowName).toBe('f');
      expect(e.cause?.message).toBe('boom');
    }
  });
});
