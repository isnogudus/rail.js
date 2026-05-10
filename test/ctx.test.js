import { describe, it, expect } from 'vitest';
import {
  isRailNode,
  exceptionCtx,
  isExceptionCtx,
  isParallelCtx,
  ctxType,
  node,
  activity,
  parallel,
} from '../rail.js';

describe('typed-ctx helpers (§3.12, acceptance #22)', () => {
  it('exceptionCtx wraps with __type=exception, inputCtx, error (by reference)', () => {
    const inputCtx = { a: 1 };
    const err = new Error('boom');
    const ec = exceptionCtx(err, inputCtx);
    expect(ec.__type).toBe('exception');
    expect(ec.inputCtx).toBe(inputCtx);
    expect(ec.error).toBe(err);
  });

  it('isExceptionCtx returns true only for __type === "exception"', () => {
    expect(isExceptionCtx({ __type: 'exception' })).toBe(true);
    expect(isExceptionCtx({ __type: 'parallel-results' })).toBe(false);
    expect(isExceptionCtx({})).toBe(false);
    expect(isExceptionCtx(null)).toBe(false);
    expect(isExceptionCtx(undefined)).toBe(false);
  });

  it('isParallelCtx returns true only for __type === "parallel-results"', () => {
    expect(isParallelCtx({ __type: 'parallel-results' })).toBe(true);
    expect(isParallelCtx({ __type: 'exception' })).toBe(false);
    expect(isParallelCtx({})).toBe(false);
    expect(isParallelCtx(null)).toBe(false);
  });

  it('ctxType returns string __type or undefined', () => {
    expect(ctxType({ __type: 'foo' })).toBe('foo');
    expect(ctxType({ __type: 42 })).toBe(undefined);
    expect(ctxType({})).toBe(undefined);
    expect(ctxType(null)).toBe(undefined);
  });
});

describe('isRailNode (§3.9)', () => {
  it('returns true for step / activity / parallel', () => {
    const s = node(() => 'ok', { outputs: ['ok'] });
    const a = activity((a) => {
      const s2 = a.entry('in');
      const ok = a.exit('ok');
      a.wire(s2, ok);
    });
    const p = parallel({ a: s });
    expect(isRailNode(s)).toBe(true);
    expect(isRailNode(a)).toBe(true);
    expect(isRailNode(p)).toBe(true);
  });

  it('returns false for other values', () => {
    expect(isRailNode(undefined)).toBe(false);
    expect(isRailNode(null)).toBe(false);
    expect(isRailNode({})).toBe(false);
    expect(isRailNode({ railKind: 42 })).toBe(false);
    expect(isRailNode(() => {})).toBe(false);
  });
});
