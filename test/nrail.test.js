/**
 * nrail — spec §6. Acceptance §16.9.
 */

import { describe, expect, it } from 'vitest';
import {
  nrail, catchTo, atom, flow,
  RailBuildError,
} from '../rail.js';

const noLog = () => {};

function expectBuildError(fn, code) {
  try {
    fn();
    throw new Error('should have thrown');
  } catch (e) {
    expect(e).toBeInstanceOf(RailBuildError);
    expect(e.code).toBe(code);
  }
}

describe('nrail entry', () => {
  it('produces __rail_kind__: activity with given entries as inputs', () => {
    const wf = nrail((r) => {
      r.entry('main');
      r.step('s', async () => {}, 'main', 'main');
    });
    expect(wf.__rail_kind__).toBe('activity');
    expect(wf.inputs).toEqual(['main']);
  });

  it('accepts multiple entry names', () => {
    const wf = nrail((r) => {
      r.entry('a', 'b');
      r.step('sa', async () => {}, 'a', 'a');
      r.step('sb', async () => {}, 'b', 'b');
    });
    expect(wf.inputs).toEqual(['a', 'b']);
  });

  it('rejects no entries (MISSING_INPUTS)', () => {
    expectBuildError(() => nrail((r) => { r.entry(); }), 'MISSING_INPUTS');
  });

  it('rejects builder method before r.entry (ENTRIES_NOT_DECLARED)', () => {
    expectBuildError(() => nrail((r) => {
      r.step('s', async () => {}, 'main', 'main');
    }), 'ENTRIES_NOT_DECLARED');
  });

  it('rejects double r.entry (ENTRIES_ALREADY_DECLARED)', () => {
    expectBuildError(() => nrail((r) => {
      r.entry('a');
      r.entry('b');
    }), 'ENTRIES_ALREADY_DECLARED');
  });

  it('rejects async builder (ASYNC_BUILDER)', () => {
    expectBuildError(() => nrail(async () => {}), 'ASYNC_BUILDER');
  });
});

describe('nrail Live-Set mechanics', () => {
  it('basic step consumes entry rail and produces output rails', async () => {
    const wf = nrail((r) => {
      r.entry('main');
      r.step('val', async (ctx) => { ctx.v = 1; return 'main'; }, 'main', ['main', 'failure']);
    });
    expect(wf.outputs).toEqual(['main', 'failure']);
    const r = await flow('f', wf).run({}, { logger: noLog });
    expect(r.exit).toBe('main');
    expect(r.ctx.v).toBe(1);
  });

  it('per-rail convergence: multiple sources to same input endpoint', async () => {
    const wf = nrail((r) => {
      r.entry('main');
      r.step('a', async () => 'main', 'main', ['main', 'fail']);
      r.step('b', async () => 'main', 'main', ['main', 'fail']);
      r.step('cleanup', async (ctx) => { ctx.cleaned = true; }, 'fail', 'fail');
    });
    expect(wf.outputs).toEqual(['main', 'fail']);
    const r = await flow('f', wf).run({}, { logger: noLog });
    expect(r.exit).toBe('main');
  });

  it('raises RAIL_NOT_LIVE when consuming missing rail', () => {
    expectBuildError(() => nrail((r) => {
      r.entry('main');
      r.step('x', async () => {}, 'noSuch', 'main');
    }), 'RAIL_NOT_LIVE');
  });

  it('duplicate node name raises DUPLICATE_NODE_NAME', () => {
    expectBuildError(() => nrail((r) => {
      r.entry('main');
      r.step('x', async () => 'main', 'main', 'main');
      r.step('x', async () => 'main', 'main', 'main');
    }), 'DUPLICATE_NODE_NAME');
  });

  it('r.addNode reads node.inputs/outputs as rails', async () => {
    const validator = atom(async (ctx) => { ctx.validated = true; return 'main'; }, {
      inputs: ['main'], outputs: ['main', 'failure'],
    });
    const wf = nrail((r) => {
      r.entry('main');
      r.addNode('val', validator);
    });
    expect(wf.outputs).toEqual(['main', 'failure']);
    const r = await flow('f', wf).run({}, { logger: noLog });
    expect(r.exit).toBe('main');
    expect(r.ctx.validated).toBe(true);
  });
});

describe('nrail labels and links', () => {
  it('backward link forms a loop', async () => {
    const wf = nrail((r) => {
      r.entry('main');
      r.label('start', 'main');
      r.step('try', async (_ctx, local) => {
        local.n = (local.n ?? 0) + 1;
        return local.n >= 3 ? 'main' : 'retry';
      }, 'main', ['main', 'retry']);
      r.link('start', 'retry');
    });
    expect(wf.outputs).toEqual(['main']);
    const result = await flow('f', wf).run({}, { logger: noLog });
    expect(result.exit).toBe('main');
  });

  it('forward link is resolved when label is declared later', async () => {
    const wf = nrail((r) => {
      r.entry('main');
      r.step('X', async () => 'special', 'main', ['main', 'special']);
      r.link('merge', 'special');
      r.step('Y', async () => 'main', 'main', 'main');
      r.label('merge', 'main');
    });
    // outputs = [main] (special consumed by link, only main remains)
    expect(wf.outputs).toEqual(['main']);
  });

  it('UNKNOWN_LABEL fires for unresolved forward link', () => {
    expectBuildError(() => nrail((r) => {
      r.entry('main');
      r.step('x', async () => 'main', 'main', ['main', 'side']);
      r.link('nope', 'side');
    }), 'UNKNOWN_LABEL');
  });

  it('UNUSED_LABEL fires for label with no incoming link', () => {
    expectBuildError(() => nrail((r) => {
      r.entry('main');
      r.label('unused', 'main');
      r.step('x', async () => 'main', 'main', 'main');
    }), 'UNUSED_LABEL');
  });
});

describe('nrail throw semantics', () => {
  it('does not catch by default — uncaught throw becomes library error', async () => {
    const wf = nrail((r) => {
      r.entry('main');
      r.step('boom', async () => { throw new Error('oops'); }, 'main', 'main');
    });
    await expect(flow('f', wf).run({}, { logger: noLog })).rejects.toThrow();
  });

  it('catchTo routes throws to a declared exit', async () => {
    const wf = nrail((r) => {
      r.entry('main');
      r.step('val', catchTo(async () => { throw new Error('bad'); }, 'fail'),
        'main', ['main', 'fail']);
    });
    const r = await flow('f', wf).run({}, { logger: noLog });
    expect(r.exit).toBe('fail');
    expect(r.ctx._error.message).toBe('bad');
  });
});
