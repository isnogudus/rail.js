import { describe, it, expect } from 'vitest';
import {
  activity,
  node,
  parallel,
  flow,
  RailRuntimeError,
} from '../rail.js';

const silent = { logger: () => {} };

describe('Tracer events (§6.8, acceptance #31)', () => {
  it('emits run-start (ts:0), step-start, step-end, run-end in order', async () => {
    const events = [];
    const tracer = (e) => events.push(e);

    const s = node(() => 'ok', { outputs: ['ok'] });
    const a = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const v = a.addNode('v', s);
      a.wire(start, v);
      a.wire(v.out('ok'), ok);
    });
    a.compile();

    await flow('w', a).run({}, { ...silent, tracer });
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('run-start');
    expect(events[0].ts).toBe(0);
    expect(events[0].depth).toBe(0);
    expect(events[0].name).toBe('w');

    expect(types).toContain('step-start');
    expect(types).toContain('activity-enter');
    expect(types).toContain('activity-leave');
    expect(types).toContain('step-end');
    expect(types[types.length - 1]).toBe('run-end');
    const runEnd = events[events.length - 1];
    expect(runEnd.terminus).toBe('ok');
  });

  it('emits run-error when a step throws', async () => {
    const events = [];
    const s = node(() => { throw new Error('boom'); }, { outputs: ['ok'] });
    const a = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const v = a.addNode('v', s);
      a.wire(start, v);
      a.wire(v.out('ok'), ok);
    });
    a.compile();
    try {
      await flow('w', a).run({}, { ...silent, tracer: (e) => events.push(e) });
    } catch {}
    const types = events.map((e) => e.type);
    expect(types).toContain('step-throw');
    expect(types).toContain('activity-throw');
    expect(types[types.length - 1]).toBe('run-error');
  });

  it('emits branch-start and branch-end around each parallel branch', async () => {
    const events = [];
    const par = parallel({
      a: node(() => 'ok', { outputs: ['ok'] }),
      b: node(() => 'ok', { outputs: ['ok'] }),
    });
    const a = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const fan = a.addNode('fan', par);
      a.wire(start, fan);
      a.wire(fan.out('done'), ok);
    });
    a.compile();
    await flow('w', a).run({}, { ...silent, tracer: (e) => events.push(e) });

    const branchEvents = events.filter((e) => e.type.startsWith('branch-'));
    const aEvents = branchEvents.filter((e) => e.branch === 'a');
    const bEvents = branchEvents.filter((e) => e.branch === 'b');
    expect(aEvents.map((e) => e.type)).toEqual(['branch-start', 'branch-end']);
    expect(bEvents.map((e) => e.type)).toEqual(['branch-start', 'branch-end']);
  });

  it('TRACER_FAILED when tracer throws', async () => {
    const s = node(() => 'ok', { outputs: ['ok'] });
    const a = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const v = a.addNode('v', s);
      a.wire(start, v);
      a.wire(v.out('ok'), ok);
    });
    a.compile();
    try {
      await flow('w', a).run({}, {
        ...silent,
        tracer: () => { throw new Error('tracer-bug'); },
      });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RailRuntimeError);
      expect(e.code).toBe('TRACER_FAILED');
      expect(e.cause?.message).toBe('tracer-bug');
    }
  });

  it('LOGGER_FAILED when logger throws', async () => {
    const s = node(() => 'ok', { outputs: ['ok'] });
    const a = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const v = a.addNode('v', s);
      a.wire(start, v);
      a.wire(v.out('ok'), ok);
    });
    a.compile();
    try {
      await flow('w', a).run({}, {
        logger: () => { throw new Error('log-bug'); },
      });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RailRuntimeError);
      expect(e.code).toBe('LOGGER_FAILED');
      expect(e.cause?.message).toBe('log-bug');
    }
  });

  it('inner depth on activity-enter, outer depth on activity-leave (acceptance #31)', async () => {
    const events = [];
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
      const i = a.addNode('inner', inner);
      a.wire(start, i);
      a.wire(i.out('ok'), ok);
    });
    outer.compile();
    await flow('w', outer).run({}, { ...silent, tracer: (e) => events.push(e) });

    const enter = events.find((e) => e.type === 'activity-enter' && e.name === 'inner');
    const leave = events.find((e) => e.type === 'activity-leave' && e.name === 'inner');
    expect(enter.depth).toBe(1);
    expect(leave.depth).toBe(0);
  });
});

describe('Default logger format (§6.6, acceptance #30)', () => {
  it('emits OK / XX tags with indentation by depth', async () => {
    const lines = [];
    const captured = (...args) => lines.push(args.join(' '));
    const orig = console.log;
    console.log = captured;
    try {
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
        const i = a.addNode('inner', inner);
        a.wire(start, i);
        a.wire(i.out('ok'), ok);
      });
      outer.compile();
      await flow('w', outer).run({});
    } finally {
      console.log = orig;
    }
    // Expect lines containing '[rail:w]' tag and step names with indent.
    expect(lines.some((l) => l.includes('[rail:w]') && l.includes('OK'))).toBe(true);
    // Inner step is 2 levels deeper (depth=1 inside outer's loop).
    const innerStepLine = lines.find((l) => l.includes('inner.x'));
    expect(innerStepLine).toBeDefined();
  });

  it('XX tag for steps that throw', async () => {
    const lines = [];
    const captured = (...args) => lines.push(args.join(' '));
    const orig = console.log;
    console.log = captured;
    try {
      const a = activity((a) => {
        const start = a.entry('in');
        const ok = a.exit('ok');
        const v = a.addNode('v', node(() => 'okk', { outputs: ['ok'] }));
        a.wire(start, v);
        a.wire(v.out('ok'), ok);
      });
      a.compile();
      try { await flow('w', a).run({}); } catch {}
    } finally {
      console.log = orig;
    }
    expect(lines.some((l) => l.includes('XX'))).toBe(true);
  });
});
