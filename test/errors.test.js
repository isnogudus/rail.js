/**
 * Error hierarchy — spec §12. Acceptance §16.14.
 */

import { describe, expect, it } from 'vitest';
import {
  RailError, RailBuildError, RailRuntimeError, RailAggregateError,
} from '../rail.js';

describe('error hierarchy', () => {
  it('all library errors are instanceof RailError', () => {
    expect(new RailBuildError('X') instanceof RailError).toBe(true);
    expect(new RailRuntimeError('X') instanceof RailError).toBe(true);
    expect(new RailAggregateError({}) instanceof RailError).toBe(true);
  });

  it('RailBuildError carries code', () => {
    const e = new RailBuildError('INVALID_NAME', { message: 'x', details: { name: 'a.b' } });
    expect(e.code).toBe('INVALID_NAME');
    expect(e.details.name).toBe('a.b');
    expect(e.name).toBe('RailBuildError');
  });

  it('RailRuntimeError carries flowName, code, cause', () => {
    const cause = new Error('underlying');
    const e = new RailRuntimeError('UNHANDLED_THROW', {
      flowName: 'f', cause, message: 'boom',
    });
    expect(e.flowName).toBe('f');
    expect(e.cause).toBe(cause);
    expect(e.code).toBe('UNHANDLED_THROW');
  });

  it('RailAggregateError carries branchErrors and errors[]', () => {
    const a = new RailRuntimeError('A');
    const b = new RailRuntimeError('B');
    const agg = new RailAggregateError({ a, b });
    expect(agg.code).toBe('PARALLEL_BRANCH_FAILED');
    expect(agg.branchErrors).toEqual({ a, b });
    expect(agg.errors).toEqual([a, b]);
    expect(agg.message).toContain('a, b');
  });
});
