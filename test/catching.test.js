import { describe, it, expect } from 'vitest';
import {
  activity,
  node,
  catching,
  flow,
  RailRuntimeError,
} from '../rail.js';

const silent = { logger: () => {} };

describe('catching(stepNode, mapping) (§3.13, acceptance #10)', () => {
  it('extends outputs as union (originals first, then mapping targets, deduped)', () => {
    const inner = node(() => 'ok', { outputs: ['ok'] });
    const wrapped = catching(inner, { NetworkError: 'net5xx', AbortError: 'cancelled' });
    expect(wrapped.outputs).toEqual(['ok', 'net5xx', 'cancelled']);
  });

  it('dedupes if mapping target equals an original output', () => {
    const inner = node(() => 'ok', { outputs: ['ok', 'fail'] });
    const wrapped = catching(inner, { NetworkError: 'fail' });
    expect(wrapped.outputs).toEqual(['ok', 'fail']);
  });

  it('preserves railKind=step and inputs', () => {
    const inner = node(() => 'ok', { inputs: ['main'], outputs: ['ok'] });
    const wrapped = catching(inner, {});
    expect(wrapped.railKind).toBe('step');
    expect(wrapped.inputs).toEqual(['main']);
  });

  it('compile delegates to inner; compiled() reflects inner', () => {
    const inner = node(() => 'ok', { outputs: ['ok'] });
    const wrapped = catching(inner, { NetworkError: 'net5xx' });
    expect(wrapped.isChecked()).toBe(false);
    wrapped.check();
    expect(wrapped.isChecked()).toBe(true);
    expect(inner.isChecked()).toBe(true);
  });

  it('translates matching error.name into mapped output', async () => {
    class NetworkError extends Error {
      constructor(m) { super(m); this.name = 'NetworkError'; }
    }
    const sendFn = async () => { throw new NetworkError('5xx'); };
    const wrapped = catching(node(sendFn, { outputs: ['ok'] }),
      { NetworkError: 'net5xx' });

    const a = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const fail = a.exit('failure');
      const send = a.addNode('send', wrapped);
      a.wire(start, send);
      a.wire(send.out('ok'), ok);
      a.wire(send.out('net5xx'), fail);
    });
    a.check();

    const r = await flow('a', a).run({}, silent);
    expect(r.terminus).toBe('failure');
  });

  it('non-matching errors propagate as UNHANDLED_THROW', async () => {
    const wrapped = catching(node(() => { throw new Error('weird'); }, { outputs: ['ok'] }),
      { NetworkError: 'net5xx' });
    const a = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const fail = a.exit('failure');
      const send = a.addNode('send', wrapped);
      a.wire(start, send);
      a.wire(send.out('ok'), ok);
      a.wire(send.out('net5xx'), fail);
    });
    a.check();
    try {
      await flow('a', a).run({}, silent);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RailRuntimeError);
      expect(e.code).toBe('UNHANDLED_THROW');
    }
  });

  it('RailRuntimeError from inner propagates unchanged (never mapped)', async () => {
    const inner = node(() => {
      throw new RailRuntimeError('UNKNOWN_OUTPUT_AT_RUNTIME', 'bug', {});
    }, { outputs: ['ok'] });
    const wrapped = catching(inner, { RailRuntimeError: 'mapped' });
    const a = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const m = a.exit('mapped');
      const s = a.addNode('s', wrapped);
      a.wire(start, s);
      a.wire(s.out('ok'), ok);
      a.wire(s.out('mapped'), m);
    });
    a.check();
    try {
      await flow('a', a).run({}, silent);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RailRuntimeError);
      // Crucially: NOT remapped to 'mapped' exit.
      expect(e.code).toBe('UNKNOWN_OUTPUT_AT_RUNTIME');
    }
  });

  it('inner step is shared across multiple catching wrappers (compiled once)', () => {
    const base = node(() => 'ok', { outputs: ['ok'] });
    const w1 = catching(base, { NetworkError: 'a' });
    const w2 = catching(base, { NetworkError: 'b' });
    expect(w1.outputs).toEqual(['ok', 'a']);
    expect(w2.outputs).toEqual(['ok', 'b']);
    w1.check();
    expect(base.isChecked()).toBe(true);
    expect(w2.isChecked()).toBe(true); // delegates to base
  });
});
