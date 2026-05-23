/**
 * pin wrapper — spec §4.1. Acceptance §16.6.
 */

import { describe, expect, it } from 'vitest';
import { pin, activity, step, atom, flow, RailBuildError } from '../rail.js';

const noLog = () => {};

describe('pin', () => {
  it('produces a node with inputs:[in] and outputs from inner', () => {
    const inner = activity((a) => {
      a.entry('fromCache', 'fromAPI');
      a.addNode('s', step(async () => {}));
      a.exit('done');
      a.wire('.fromCache', 's.success');
      a.wire('.fromAPI',   's.success');
      a.wire('s.success', '.done');
      a.wire('s.failure', '.done');
    });
    const p = pin(inner, 'fromCache');
    expect(p.__rail_kind__).toBe('pin');
    expect(p.inputs).toEqual(['in']);
    expect(p.outputs).toEqual(['done']);
    expect(p._inner).toBe(inner);
  });

  it('rejects unknown entry (UNRESOLVED_WIRE_REFERENCE)', () => {
    const inner = atom(async () => 'ok', { inputs: ['a', 'b'], outputs: ['ok'] });
    try {
      pin(inner, 'c');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RailBuildError);
      expect(e.code).toBe('UNRESOLVED_WIRE_REFERENCE');
    }
  });

  it('rejects non-node (NOT_A_NODE)', () => {
    try {
      pin({}, 'in');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RailBuildError);
      expect(e.code).toBe('NOT_A_NODE');
    }
  });

  it('routes the outer entry to the pinned inner entry at runtime', async () => {
    const inner = atom(async (ctx, _local, runInfo) => {
      ctx.entryUsed = runInfo.traceEntry.entry;
      return 'ok';
    }, { inputs: ['a', 'b'], outputs: ['ok'] });
    const p = pin(inner, 'b');
    const r = await flow('f', p).run({}, { logger: noLog });
    expect(r.ctx.entryUsed).toBe('b');
    expect(r.exit).toBe('ok');
  });

  it('is trace-transparent — pin does not push its own trace entry', async () => {
    const inner = atom(async () => 'ok', { inputs: ['a'], outputs: ['ok'] });
    const p = pin(inner, 'a');
    const r = await flow('f', p).run({}, { logger: noLog });
    expect(r.trace.length).toBe(1);
    expect(r.trace[0].kind).toBe('atom');
  });
});
