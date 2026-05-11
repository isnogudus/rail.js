import { describe, it, expect } from 'vitest';
import {
  activity,
  node,
  flow,
  RailBuildError,
  RailRuntimeError,
} from '../rail.js';

const silent = { logger: () => {} };

function trivialActivity() {
  const a = activity((a) => {
    const start = a.entry('in');
    const ok = a.exit('ok');
    const s = a.addNode('s', node(() => 'ok', { outputs: ['ok'] }));
    a.wire(start, s);
    a.wire(s.out('ok'), ok);
  });
  a.check();
  return a;
}

describe('flow(name, node) factory (§3.6, §5.4)', () => {
  it('INVALID_NAME (acceptance #17)', () => {
    const a = trivialActivity();
    try { flow('', a); throw new Error('no throw'); } catch (e) {
      expect(e).toBeInstanceOf(RailBuildError);
      expect(e.code).toBe('INVALID_NAME');
    }
    try { flow(/** @type {any} */ (null), a); throw new Error('no throw'); } catch (e) {
      expect(e.code).toBe('INVALID_NAME');
    }
    try { flow('with.dot', a); throw new Error('no throw'); } catch (e) {
      expect(e.code).toBe('INVALID_NAME');
    }
  });

  it('NOT_A_NODE (acceptance #16)', () => {
    try { flow('f', /** @type {any} */ ({})); throw new Error('no throw'); } catch (e) {
      expect(e).toBeInstanceOf(RailBuildError);
      expect(e.code).toBe('NOT_A_NODE');
    }
  });

  it('flow.run() auto-checks an unchecked node (acceptance #15)', async () => {
    const a = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const s = a.addNode('s', node(() => 'ok', { outputs: ['ok'] }));
      a.wire(start, s);
      a.wire(s.out('ok'), ok);
    });
    expect(a.isChecked()).toBe(false);
    const f = flow('f', a);
    expect(a.isChecked()).toBe(false);   // factory does NOT check
    const r = await f.run({}, silent);
    expect(a.isChecked()).toBe(true);
    expect(r.terminus).toBe('ok');
  });

  it('returns a stateless plain object (acceptance #32)', async () => {
    const a = trivialActivity();
    const f = flow('f', a);
    expect(typeof f.run).toBe('function');
    expect(typeof f.toMermaid).toBe('function');
    expect(f.name).toBe('f');
    expect(f.node).toBe(a);
    expect(f.constructor.name).toBe('Object');

    // Concurrent runs are independent.
    const [r1, r2, r3] = await Promise.all([
      f.run({ n: 1 }, silent),
      f.run({ n: 2 }, silent),
      f.run({ n: 3 }, silent),
    ]);
    expect(r1.ctx.n).toBe(1);
    expect(r2.ctx.n).toBe(2);
    expect(r3.ctx.n).toBe(3);
  });

  it('RunResult has terminus, ctx, trace', async () => {
    const a = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const s = a.addNode('s', node((c) => ({ output: 'ok', ctx: { ...c, x: 1 } }),
        { outputs: ['ok'] }));
      a.wire(start, s);
      a.wire(s.out('ok'), ok);
    });
    a.check();
    const r = await flow('f', a).run({ y: 2 }, silent);
    expect(r.terminus).toBe('ok');
    expect(r.ctx).toEqual({ y: 2, x: 1 });
    expect(r.trace.length).toBeGreaterThan(0);
  });
});
