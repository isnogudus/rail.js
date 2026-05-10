import { describe, it, expect } from 'vitest';
import {
  activity,
  node,
  parallel,
  catching,
  RailBuildError,
} from '../rail.js';

describe('Synchronous wire / handle validation (§3.3, §3.4, §5.4)', () => {
  it('UNKNOWN_PORT on .out("typo") (acceptance #11)', () => {
    activity((a) => {
      const v = a.addNode('v', node(() => 'ok', { outputs: ['ok', 'bad'] }));
      expect(() => v.out('okk')).toThrow(RailBuildError);
      try { v.out('okk'); } catch (e) {
        expect(e.code).toBe('UNKNOWN_PORT');
      }
    });
  });

  it('UNKNOWN_PORT on .in("typo")', () => {
    activity((a) => {
      const r = a.addNode('r', node(() => 'ok', { inputs: ['retry', 'skip'], outputs: ['ok'] }));
      try { r.in('xyz'); } catch (e) {
        expect(e).toBeInstanceOf(RailBuildError);
        expect(e.code).toBe('UNKNOWN_PORT');
      }
    });
  });

  it('INVALID_WIRE_DIRECTION when source is an exit (acceptance #12)', () => {
    activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      // source must be entry or node-output; exit is wrong
      try { a.wire(ok, ok); throw new Error('no throw'); } catch (e) {
        expect(e).toBeInstanceOf(RailBuildError);
        expect(e.code).toBe('INVALID_WIRE_DIRECTION');
      }
      // Restore so builder doesn't blow up later in .wire calls.
      a.wire(start, ok);
    });
  });

  it('INVALID_WIRE_DIRECTION when target is an entry', () => {
    activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      try { a.wire(start, start); throw new Error('no throw'); } catch (e) {
        expect(e).toBeInstanceOf(RailBuildError);
        expect(e.code).toBe('INVALID_WIRE_DIRECTION');
      }
      a.wire(start, ok);
    });
  });

  it('AMBIGUOUS_NODE_INPUT when target node has multiple inputs (acceptance #13)', () => {
    activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const r = a.addNode('r', node(() => 'ok', { inputs: ['retry', 'skip'], outputs: ['ok'] }));
      try { a.wire(start, r); throw new Error('no throw'); } catch (e) {
        expect(e).toBeInstanceOf(RailBuildError);
        expect(e.code).toBe('AMBIGUOUS_NODE_INPUT');
        expect(e.node).toBe('r');
      }
      a.wire(start, r.in('retry'));
      a.wire(r.out('ok'), ok);
    });
  });

  it('WIRE_FROM_OTHER_BUILDER when handle from another builder (acceptance #14)', () => {
    let stolenStart;
    activity((a) => {
      stolenStart = a.entry('in');
      const ok = a.exit('ok');
      a.wire(stolenStart, ok);
    });
    activity((a) => {
      const ok = a.exit('ok');
      try { a.wire(stolenStart, ok); throw new Error('no throw'); } catch (e) {
        expect(e).toBeInstanceOf(RailBuildError);
        expect(e.code).toBe('WIRE_FROM_OTHER_BUILDER');
      }
      const start = a.entry('in');
      a.wire(start, ok);
    });
  });

  it('CATCHING_REQUIRES_STEP when wrapping non-Step (acceptance #10)', () => {
    const a = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      a.wire(start, ok);
    });
    expect(() => catching(a, {})).toThrow(RailBuildError);
    try { catching(a, {}); } catch (e) {
      expect(e.code).toBe('CATCHING_REQUIRES_STEP');
    }

    const p = parallel({ x: node(() => 'ok', { outputs: ['ok'] }) });
    expect(() => catching(p, {})).toThrow(RailBuildError);
  });
});
