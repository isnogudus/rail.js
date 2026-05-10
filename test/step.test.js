import { describe, it, expect } from 'vitest';
import { node, activity, flow, RailCompileError, RailRuntimeError } from '../rail.js';

const silent = { logger: () => {} };

describe('Step-Node (§3.2, §4)', () => {
  it('exposes railKind, inputs default ["in"], and given outputs', () => {
    const s = node(() => 'ok', { outputs: ['ok', 'bad'] });
    expect(s.railKind).toBe('step');
    expect(s.inputs).toEqual(['in']);
    expect(s.outputs).toEqual(['ok', 'bad']);
  });

  it('accepts custom inputs', () => {
    const s = node(() => 'ok', { inputs: ['retry', 'skip'], outputs: ['ok'] });
    expect(s.inputs).toEqual(['retry', 'skip']);
  });

  it('compile validates outputs (non-empty, no duplicates) and inputs', () => {
    const empty = node(() => 'ok', { outputs: [] });
    expect(() => empty.compile()).toThrow(RailCompileError);
    try { empty.compile(); } catch (e) {
      expect(e.errors.some((x) => x.code === 'EMPTY_OUTPUTS')).toBe(true);
    }

    const dup = node(() => 'ok', { outputs: ['ok', 'ok'] });
    try { dup.compile(); throw new Error('expected throw'); } catch (e) {
      expect(e).toBeInstanceOf(RailCompileError);
      expect(e.errors.some((x) => x.code === 'DUPLICATE_OUTPUT' && x.output === 'ok')).toBe(true);
    }

    const dupIn = node(() => 'ok', { inputs: ['x', 'x'], outputs: ['ok'] });
    try { dupIn.compile(); throw new Error('expected throw'); } catch (e) {
      expect(e).toBeInstanceOf(RailCompileError);
      expect(e.errors.some((x) => x.code === 'DUPLICATE_INPUT' && x.input === 'x')).toBe(true);
    }
  });

  it('compile is idempotent (acceptance #20)', () => {
    const s = node(() => 'ok', { outputs: ['ok'] });
    s.compile();
    expect(s.compiled()).toBe(true);
    // Second call returns immediately.
    expect(() => s.compile()).not.toThrow();
    expect(s.compiled()).toBe(true);
  });

  it('translates string return into { output } shape (top-level step, acceptance #5)', async () => {
    const s = node(() => 'done', { outputs: ['done'] });
    s.compile();
    const r = await flow('greet', s).run({ name: 'M' }, silent);
    expect(r.terminus).toBe('done');
    expect(r.ctx).toEqual({ name: 'M' });
  });

  it('translates { output, ctx } return and replaces running ctx', async () => {
    const s = node(
      async (ctx) => ({ output: 'done', ctx: { ...ctx, x: 42 } }),
      { outputs: ['done'] }
    );
    s.compile();
    const r = await flow('greet', s).run({ name: 'M' }, silent);
    expect(r.terminus).toBe('done');
    expect(r.ctx).toEqual({ name: 'M', x: 42 });
  });

  it('throws RailRuntimeError(UNKNOWN_OUTPUT_AT_RUNTIME) for unknown output', async () => {
    const s = node(() => 'okk', { outputs: ['ok'] });
    s.compile();
    try {
      await flow('typo', s).run({}, silent);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RailRuntimeError);
      expect(e.code).toBe('UNKNOWN_OUTPUT_AT_RUNTIME');
    }
  });

  it('user fn throws → wrapped as UNHANDLED_THROW with cause', async () => {
    const original = new Error('kaboom');
    const s = node(() => { throw original; }, { outputs: ['ok'] });
    s.compile();
    try {
      await flow('boom', s).run({}, silent);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RailRuntimeError);
      expect(e.code).toBe('UNHANDLED_THROW');
      expect(e.cause).toBe(original);
    }
  });

  it('top-level Step-Node sees runInfo.input = first declared input (acceptance #9)', async () => {
    let captured;
    const s = node(
      (_ctx, runInfo) => { captured = runInfo.input; return 'ok'; },
      { inputs: ['in'], outputs: ['ok'] }
    );
    s.compile();
    await flow('s', s).run({}, silent);
    expect(captured).toBe('in');
  });

  it('multi-input runInfo.input reports activated port (acceptance #9)', async () => {
    let captured;
    const recover = node(
      (_ctx, runInfo) => { captured = runInfo.input; return 'ok'; },
      { inputs: ['retry', 'skip'], outputs: ['ok'] }
    );
    const trigger = node((c) => ({ output: c.path, ctx: c }), { outputs: ['retry', 'skip'] });

    const a = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const t = a.addNode('t', trigger);
      const r = a.addNode('r', recover);
      a.wire(start, t);
      a.wire(t.out('retry'), r.in('retry'));
      a.wire(t.out('skip'), r.in('skip'));
      a.wire(r.out('ok'), ok);
    });
    a.compile();

    await flow('a', a).run({ path: 'retry' }, silent);
    expect(captured).toBe('retry');
    await flow('a', a).run({ path: 'skip' }, silent);
    expect(captured).toBe('skip');
  });
});
