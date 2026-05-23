/**
 * flow — spec §9. Acceptance §16.11–§16.14.
 */

import { describe, expect, it } from 'vitest';
import {
  flow, atom, step, activity, pin, parallel,
  RailBuildError, RailRuntimeError, RailError,
} from '../rail.js';

const noLog = () => {};

describe('flow construction', () => {
  it('returns { name, node, run, toMermaid }', () => {
    const f = flow('x', step(async () => {}));
    expect(f.name).toBe('x');
    expect(typeof f.run).toBe('function');
    expect(typeof f.toMermaid).toBe('function');
  });

  it('rejects empty/whitespace name with INVALID_NAME', () => {
    expect(() => flow('', step(async () => {}))).toThrow(RailBuildError);
    expect(() => flow('  ', step(async () => {}))).toThrow(RailBuildError);
  });

  it('rejects non-node second arg with NOT_A_NODE', () => {
    try {
      flow('f', { hi: 1 });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('NOT_A_NODE');
    }
  });

  it('rejects multi-input node with MULTI_INPUT_NODE', () => {
    const multi = atom(async () => 'ok', { inputs: ['a', 'b'], outputs: ['ok'] });
    try {
      flow('f', multi);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('MULTI_INPUT_NODE');
    }
  });

  it('accepts a pin-wrapped multi-input node', () => {
    const multi = atom(async () => 'ok', { inputs: ['a', 'b'], outputs: ['ok'] });
    const f = flow('f', pin(multi, 'a'));
    expect(f).toBeTruthy();
  });
});

describe('flow.run', () => {
  it('defaults ctx to {}', async () => {
    const n = atom(async (ctx) => { ctx.touched = true; return 'ok'; }, { outputs: ['ok'] });
    const r = await flow('f', n).run(undefined, { logger: noLog });
    expect(r.ctx.touched).toBe(true);
    expect(r.exit).toBe('ok');
  });

  it('returns RunResult shape { exit, ctx, trace }', async () => {
    const r = await flow('f', step(async () => {})).run({}, { logger: noLog });
    expect(Object.keys(r).sort()).toEqual(['ctx', 'exit', 'trace']);
  });

  it('wraps non-library throws as UNHANDLED_THROW', async () => {
    const n = atom(async () => { throw new Error('oops'); }, { outputs: ['ok'] });
    try {
      await flow('f', n).run({}, { logger: noLog });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RailRuntimeError);
      expect(e.code).toBe('UNHANDLED_THROW');
      expect(e.flowName).toBe('f');
      expect(e.cause).toBeInstanceOf(Error);
      expect(e.cause.message).toBe('oops');
    }
  });

  it('propagates RailError with flowName set', async () => {
    const n = atom(async () => 'xx', { outputs: ['ok'] }); // unknown output
    try {
      await flow('myflow', n).run({}, { logger: noLog });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RailError);
      expect(e.code).toBe('UNKNOWN_OUTPUT_AT_RUNTIME');
      expect(e.flowName).toBe('myflow');
    }
  });

  it('supports concurrent runs on the same flow', async () => {
    let counter = 0;
    const n = atom(async (ctx) => {
      ctx.start = counter++;
      await new Promise((r) => setTimeout(r, 10));
      ctx.end = counter++;
      return 'ok';
    }, { outputs: ['ok'] });
    const f = flow('f', n);
    const [r1, r2] = await Promise.all([
      f.run({}, { logger: noLog }),
      f.run({}, { logger: noLog }),
    ]);
    expect(r1.exit).toBe('ok');
    expect(r2.exit).toBe('ok');
    // Both runs touched the same node concurrently — they shared the
    // counter but had independent ctx and trace.
    expect(r1.ctx).not.toBe(r2.ctx);
    expect(r1.trace).not.toBe(r2.trace);
  });

  it('top-level step run produces a single trace entry with the right shape', async () => {
    const r = await flow('greet', step(async (ctx) => { ctx.g = true; })).run({}, { logger: noLog });
    expect(r.exit).toBe('success');
    expect(r.ctx.g).toBe(true);
    expect(r.trace.length).toBe(1);
    const e = r.trace[0];
    expect(e.path).toEqual([]);
    expect(e.kind).toBe('atom');
    expect(e.cycle).toBe(1);
    expect(e.entry).toBe('success');
    expect(e.exit).toBe('success');
    expect(typeof e.startTime).toBe('number');
    expect(typeof e.endTime).toBe('number');
    expect(e.endTime).toBeGreaterThanOrEqual(e.startTime);
  });
});

describe('trace shape (§16.3)', () => {
  it('ctx and local are shallow snapshots taken at push time', async () => {
    const n = atom(async (ctx) => { ctx.late = true; return 'ok'; }, { outputs: ['ok'] });
    const r = await flow('f', n).run({ early: 1 }, { logger: noLog });
    expect(r.trace[0].ctx).toEqual({ early: 1 });
    expect(r.trace[0].ctx.late).toBeUndefined();
  });

  it('on throw the entry remains unfilled (no endTime, no exit)', async () => {
    const n = atom(async () => { throw new Error('x'); }, { outputs: ['ok'] });
    let traceCapture;
    try {
      await flow('f', n).run({}, {
        logger: noLog,
        tracer: (entry, _ev) => { traceCapture = entry; },
      });
    } catch {}
    expect(traceCapture.endTime).toBeUndefined();
    expect(traceCapture.exit).toBeUndefined();
  });

  it('trace contains exactly one entry per successful step', async () => {
    const wf = activity((a) => {
      a.entry('in');
      a.addNode('a', step(async () => {}));
      a.addNode('b', step(async () => {}));
      a.exit('done');
      a.wire('.in', 'a.success');
      a.wire('a.success', 'b.success');
      a.wire('a.failure', '.done');
      a.wire('b.success', '.done');
      a.wire('b.failure', '.done');
    });
    const r = await flow('f', wf).run({}, { logger: noLog });
    // 1 activity + 2 sub-atoms = 3 entries.
    expect(r.trace.length).toBe(3);
  });
});

describe('tracer (§16.4)', () => {
  it('emits begin and end events for every successfully completed step', async () => {
    const events = [];
    const wf = activity((a) => {
      a.entry('in');
      a.addNode('s', step(async () => {}));
      a.exit('done');
      a.wire('.in', 's.success');
      a.wire('s.success', '.done');
      a.wire('s.failure', '.done');
    });
    await flow('f', wf).run({}, {
      logger: noLog,
      tracer: (entry, event) => events.push({ event, path: entry.path.join('.') }),
    });
    expect(events).toEqual([
      { event: 'begin', path: '' },
      { event: 'begin', path: 's' },
      { event: 'end',   path: 's' },
      { event: 'end',   path: '' },
    ]);
  });

  it('on step throw, no end event for that step', async () => {
    const events = [];
    const wf = activity((a) => {
      a.entry('in');
      a.addNode('s', atom(async () => { throw new Error('boom'); }, { outputs: ['ok'] }));
      a.exit('done');
      a.wire('.in', 's.in');
      a.wire('s.ok', '.done');
    });
    try {
      await flow('f', wf).run({}, {
        logger: noLog,
        tracer: (entry, event) => events.push({ event, path: entry.path.join('.') }),
      });
    } catch {}
    const sEvents = events.filter((e) => e.path === 's');
    expect(sEvents).toEqual([{ event: 'begin', path: 's' }]);
  });

  it('swallow policy drops tracer exceptions (default)', async () => {
    const wf = step(async () => {});
    const r = await flow('f', wf).run({}, {
      logger: noLog,
      tracer: () => { throw new Error('tracer bug'); },
    });
    expect(r.exit).toBe('success');
  });

  it('throw policy propagates tracer exceptions', async () => {
    await expect(flow('f', step(async () => {})).run({}, {
      logger: noLog,
      tracer: () => { throw new Error('tracer bug'); },
      tracerErrorPolicy: 'throw',
    })).rejects.toThrow('tracer bug');
  });

  it('pin emits no tracer events', async () => {
    const events = [];
    const inner = atom(async () => 'ok', { inputs: ['x'], outputs: ['ok'] });
    await flow('f', pin(inner, 'x')).run({}, {
      logger: noLog,
      tracer: (entry, event) => events.push({ event, kind: entry.kind }),
    });
    // Only the atom should emit, not the pin wrapper.
    expect(events.map((e) => e.kind)).toEqual(['atom', 'atom']);
  });
});

describe('cancellation', () => {
  it('killSignal aborts the run with RailRuntimeError(KILLED)', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const wf = step(async () => {});
    try {
      await flow('f', wf).run({}, { logger: noLog, killSignal: ctrl.signal });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RailRuntimeError);
      expect(e.code).toBe('KILLED');
      expect(e.flowName).toBe('f');
    }
  });

  it('runInfo.signal aborts when caller signal fires', async () => {
    const ctrl = new AbortController();
    let signalSeen;
    const n = atom(async (_ctx, _local, runInfo) => {
      signalSeen = runInfo.signal;
      return 'ok';
    }, { outputs: ['ok'] });
    await flow('f', n).run({}, { logger: noLog, signal: ctrl.signal });
    expect(signalSeen).toBeTruthy();
    ctrl.abort();
    expect(signalSeen.aborted).toBe(true);
  });
});

describe('step budget', () => {
  it('throws STEP_BUDGET_EXCEEDED when trace exceeds maxSteps', async () => {
    const wf = activity((a) => {
      a.entry('in');
      a.addNode('loop', atom(async () => 'again', { inputs: ['in'], outputs: ['again', 'out'] }));
      a.exit('done');
      a.wire('.in', 'loop.in');
      a.wire('loop.again', 'loop.in');
      a.wire('loop.out', '.done');
    });
    try {
      await flow('f', wf).run({}, { logger: noLog, maxSteps: 5 });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RailRuntimeError);
      expect(e.code).toBe('STEP_BUDGET_EXCEEDED');
    }
  });
});
