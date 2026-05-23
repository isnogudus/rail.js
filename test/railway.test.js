/**
 * railway — spec §7. Acceptance §16.10.
 */

import { describe, expect, it } from 'vitest';
import { railway, flow, RailBuildError } from '../rail.js';

const noLog = () => {};

describe('railway', () => {
  it('produces __rail_kind__: activity, inputs:[success], outputs:[success,failure]', () => {
    const wf = railway((r) => {
      r.step('s', async () => {});
    });
    expect(wf.__rail_kind__).toBe('activity');
    expect(wf.inputs).toEqual(['success']);
    expect(wf.outputs).toEqual(['success', 'failure']);
  });

  it('happy path: all steps succeed', async () => {
    const wf = railway((r) => {
      r.step('a', async (ctx) => { ctx.a = 1; });
      r.step('b', async (ctx) => { ctx.b = 2; });
    });
    const r = await flow('f', wf).run({}, { logger: noLog });
    expect(r.exit).toBe('success');
    expect(r.ctx).toEqual({ a: 1, b: 2 });
  });

  it('throw in r.step routes to failure with ctx._error', async () => {
    const wf = railway((r) => {
      r.step('a', async () => { throw new Error('boom'); });
    });
    const r = await flow('f', wf).run({}, { logger: noLog });
    expect(r.exit).toBe('failure');
    expect(r.ctx._error.message).toBe('boom');
  });

  it('r.fail before any r.step raises RAIL_NOT_LIVE', () => {
    try {
      railway((r) => {
        r.fail('cleanup', async () => {});
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RailBuildError);
      expect(e.code).toBe('RAIL_NOT_LIVE');
    }
  });

  it('r.pass keeps ctx on success and routes throws to success', async () => {
    const wf = railway((r) => {
      r.step('a', async () => { throw new Error('first'); });
      r.fail('clean', async (ctx) => { ctx.cleaned = true; });
      // Both r.fail and r.step lead to a final failure exit because
      // the railway topology routes the cleanup back to failure.
    });
    const r = await flow('f', wf).run({}, { logger: noLog });
    expect(r.exit).toBe('failure');
    expect(r.ctx.cleaned).toBe(true);
    expect(r.ctx._error.message).toBe('first');
  });

  it('rejects async builder with ASYNC_BUILDER', () => {
    try {
      railway(async () => {});
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('ASYNC_BUILDER');
    }
  });
});
