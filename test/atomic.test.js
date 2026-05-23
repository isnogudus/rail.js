/**
 * Atomic builders — spec §3, §11. Acceptance §16.5.
 */

import { describe, expect, it } from 'vitest';
import {
  atom, nstep, step, pass, fail, catchTo,
  flow,
  isRailNode,
  RailBuildError, RailError, RailRuntimeError,
} from '../rail.js';

const noLog = () => {};

describe('atom', () => {
  it('produces an atom node with __rail_type__ and __rail_kind__', () => {
    const n = atom(async () => 'ok', { outputs: ['ok'] });
    expect(n.__rail_type__).toBe('node');
    expect(n.__rail_kind__).toBe('atom');
    expect(isRailNode(n)).toBe(true);
    expect(n.inputs).toEqual(['in']);
    expect(n.outputs).toEqual(['ok']);
  });

  it('defaults inputs to ["in"]', () => {
    const n = atom(async () => 'ok', { outputs: ['ok'] });
    expect(n.inputs).toEqual(['in']);
  });

  it('rejects non-function fn with TypeError', () => {
    expect(() => atom(123, { outputs: ['ok'] })).toThrow(TypeError);
  });

  it('rejects non-plain-object options with TypeError', () => {
    expect(() => atom(async () => {}, 'bad')).toThrow(TypeError);
  });

  it('rejects missing outputs with RailBuildError(MISSING_OUTPUTS)', () => {
    try {
      atom(async () => {}, {});
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RailBuildError);
      expect(e.code).toBe('MISSING_OUTPUTS');
    }
  });

  it('rejects empty outputs array with MISSING_OUTPUTS', () => {
    try {
      atom(async () => {}, { outputs: [] });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('MISSING_OUTPUTS');
    }
  });

  it('rejects duplicate outputs with DUPLICATE_OUTPUT', () => {
    try {
      atom(async () => 'a', { outputs: ['a', 'a'] });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('DUPLICATE_OUTPUT');
    }
  });

  it('rejects port names containing a dot with INVALID_NAME', () => {
    try {
      atom(async () => 'a.b', { outputs: ['a.b'] });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('INVALID_NAME');
    }
  });

  it('runs and routes to the returned exit', async () => {
    const n = atom(async (ctx) => { ctx.x = 1; return 'b'; }, { outputs: ['a', 'b'] });
    const r = await flow('f', n).run({}, { logger: noLog });
    expect(r.exit).toBe('b');
    expect(r.ctx.x).toBe(1);
  });

  it('raises UNKNOWN_OUTPUT_AT_RUNTIME on unknown exit', async () => {
    const n = atom(async () => 'nope', { outputs: ['ok'] });
    try {
      await flow('f', n).run({}, { logger: noLog });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RailRuntimeError);
      expect(e.code).toBe('UNKNOWN_OUTPUT_AT_RUNTIME');
      expect(e.flowName).toBe('f');
    }
  });
});

describe('nstep', () => {
  it('accepts string-or-array inputs and outputs', () => {
    const a = nstep(async () => 'ok', 'in', 'ok');
    expect(a.inputs).toEqual(['in']);
    expect(a.outputs).toEqual(['ok']);
    const b = nstep(async () => 'ok', ['in'], ['ok', 'err']);
    expect(b.inputs).toEqual(['in']);
    expect(b.outputs).toEqual(['ok', 'err']);
    expect(a.__rail_kind__).toBe('atom');
  });

  it('accepts nullish return for single-output nodes', async () => {
    const a = nstep(async (ctx) => { ctx.done = true; }, 'in', 'ok');
    const r = await flow('f', a).run({}, { logger: noLog });
    expect(r.exit).toBe('ok');
    expect(r.ctx.done).toBe(true);
  });

  it('accepts null explicit return for single-output nodes', async () => {
    const a = nstep(async () => null, 'in', 'ok');
    const r = await flow('f', a).run({}, { logger: noLog });
    expect(r.exit).toBe('ok');
  });

  it('rejects nullish return for multi-output via UNKNOWN_OUTPUT_AT_RUNTIME', async () => {
    const a = nstep(async () => undefined, 'in', ['ok', 'err']);
    try {
      await flow('f', a).run({}, { logger: noLog });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RailRuntimeError);
      expect(e.code).toBe('UNKNOWN_OUTPUT_AT_RUNTIME');
    }
  });
});

describe('step / pass / fail', () => {
  it('step produces inputs=success, outputs=[success,failure]', () => {
    const s = step(async () => {});
    expect(s.inputs).toEqual(['success']);
    expect(s.outputs).toEqual(['success', 'failure']);
    expect(s.__rail_kind__).toBe('atom');
  });

  it('step routes normal return to success', async () => {
    const s = step(async (ctx) => { ctx.ok = true; });
    const r = await flow('f', s).run({}, { logger: noLog });
    expect(r.exit).toBe('success');
    expect(r.ctx.ok).toBe(true);
  });

  it('step routes throw to failure with ctx._error', async () => {
    const e = new Error('boom');
    const s = step(async () => { throw e; });
    const r = await flow('f', s).run({}, { logger: noLog });
    expect(r.exit).toBe('failure');
    expect(r.ctx._error).toBe(e);
  });

  it('pass routes both normal and throw to success', async () => {
    const p1 = pass(async () => {});
    const r1 = await flow('f', p1).run({}, { logger: noLog });
    expect(r1.exit).toBe('success');

    const p2 = pass(async () => { throw new Error('x'); });
    const r2 = await flow('f', p2).run({}, { logger: noLog });
    expect(r2.exit).toBe('success');
    expect(r2.ctx._error?.message).toBe('x');
  });

  it('fail has inputs=failure, outputs=failure', () => {
    const f1 = fail(async () => {});
    expect(f1.inputs).toEqual(['failure']);
    expect(f1.outputs).toEqual(['failure']);
  });

  it('step re-throws RailError', async () => {
    const re = new RailRuntimeError('SOMETHING', { message: 'lib err' });
    const s = step(async () => { throw re; });
    try {
      await flow('f', s).run({}, { logger: noLog });
      throw new Error('should have thrown');
    } catch (caught) {
      expect(caught).toBe(re);
      expect(caught).toBeInstanceOf(RailError);
    }
  });
});

describe('catchTo', () => {
  it('routes non-library throws to exitName and sets ctx._error', async () => {
    const fn = catchTo(async () => { throw new Error('oops'); }, 'failed');
    const ctx = {};
    const result = await fn(ctx, {}, {});
    expect(result).toBe('failed');
    expect(ctx._error.message).toBe('oops');
  });

  it('re-throws RailError', async () => {
    const fn = catchTo(async () => { throw new RailRuntimeError('X'); }, 'failed');
    await expect(fn({}, {}, {})).rejects.toBeInstanceOf(RailError);
  });

  it('passes through the wrapped function exit on normal return', async () => {
    const fn = catchTo(async () => 'main', 'failed');
    expect(await fn({}, {}, {})).toBe('main');
  });
});
