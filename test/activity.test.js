/**
 * Activity builder + runtime walk — spec §5. Acceptance §16.7.
 */

import { describe, expect, it } from 'vitest';
import {
  activity, atom, step, flow, pin,
  RailBuildError, RailRuntimeError,
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

describe('activity builder eager validation', () => {
  it('requires a function', () => {
    expect(() => activity(123)).toThrow(TypeError);
  });

  it('rejects async builder with ASYNC_BUILDER', () => {
    expectBuildError(() => activity(async () => {}), 'ASYNC_BUILDER');
  });

  it('rejects builder that returns any non-undefined value', () => {
    expectBuildError(() => activity(() => 42), 'ASYNC_BUILDER');
  });

  it('rejects duplicate entry names (DUPLICATE_INPUT)', () => {
    expectBuildError(() => activity((a) => {
      a.entry('in');
      a.entry('in');
    }), 'DUPLICATE_INPUT');
  });

  it('rejects duplicate exit names (DUPLICATE_OUTPUT)', () => {
    expectBuildError(() => activity((a) => {
      a.entry('in');
      a.exit('done');
      a.exit('done');
    }), 'DUPLICATE_OUTPUT');
  });

  it('rejects duplicate sub-node names (DUPLICATE_NODE_NAME)', () => {
    expectBuildError(() => activity((a) => {
      a.entry('in');
      a.addNode('s', step(async () => {}));
      a.addNode('s', step(async () => {}));
    }), 'DUPLICATE_NODE_NAME');
  });

  it('rejects non-rail-node in addNode (NOT_A_NODE)', () => {
    expectBuildError(() => activity((a) => {
      a.entry('in');
      a.addNode('x', { hello: 'world' });
    }), 'NOT_A_NODE');
  });

  it('rejects invalid names (INVALID_NAME)', () => {
    expectBuildError(() => activity((a) => a.entry('a.b')), 'INVALID_NAME');
    expectBuildError(() => activity((a) => a.entry('  ')), 'INVALID_NAME');
  });

  it('rejects wire to unknown sub-node (UNRESOLVED_WIRE_REFERENCE)', () => {
    expectBuildError(() => activity((a) => {
      a.entry('in');
      a.exit('done');
      a.wire('.in', 'unknown.in');
    }), 'UNRESOLVED_WIRE_REFERENCE');
  });

  it('rejects wire without dot (UNRESOLVED_WIRE_REFERENCE)', () => {
    expectBuildError(() => activity((a) => {
      a.entry('in');
      a.exit('done');
      a.wire('in', '.done');
    }), 'UNRESOLVED_WIRE_REFERENCE');
  });

  it('rejects wire whose source is an exit (WIRE_DIRECTION_INVALID)', () => {
    expectBuildError(() => activity((a) => {
      a.entry('in');
      a.exit('done');
      a.addNode('s', step(async () => {}));
      a.wire('.done', 's.success');
    }), 'WIRE_DIRECTION_INVALID');
  });

  it('rejects wire whose target is an entry (WIRE_DIRECTION_INVALID)', () => {
    expectBuildError(() => activity((a) => {
      a.entry('in');
      a.exit('done');
      a.addNode('s', step(async () => {}));
      a.wire('s.success', '.in');
    }), 'WIRE_DIRECTION_INVALID');
  });

  it('rejects wire whose source is a sub-node input (WIRE_DIRECTION_INVALID)', () => {
    expectBuildError(() => activity((a) => {
      a.entry('in');
      a.exit('done');
      a.addNode('s', step(async () => {}));
      a.addNode('t', step(async () => {}));
      a.wire('s.success', '.done');
      a.wire('s.success', 't.success'); // already wired
    }), 'MULTIPLE_OUTGOING_WIRES');
  });

  it('rejects multiple wires from same source (MULTIPLE_OUTGOING_WIRES)', () => {
    expectBuildError(() => activity((a) => {
      a.entry('in');
      a.addNode('s', step(async () => {}));
      a.addNode('t', step(async () => {}));
      a.exit('done');
      a.wire('.in', 's.success');
      a.wire('.in', 't.success'); // entry already wired
    }), 'MULTIPLE_OUTGOING_WIRES');
  });
});

describe('activity sealing', () => {
  it('raises SEALED when builder methods are called after closure returns', () => {
    let captured;
    activity((a) => {
      captured = a;
      a.entry('in');
      a.exit('done');
      a.addNode('s', step(async () => {}));
      a.wire('.in', 's.success');
      a.wire('s.success', '.done');
      a.wire('s.failure', '.done');
    });
    expectBuildError(() => captured.entry('x'), 'SEALED');
    expectBuildError(() => captured.addNode('x', step(async () => {})), 'SEALED');
  });
});

describe('activity whole-graph walk', () => {
  it('raises MISSING_INPUTS when no entries', () => {
    expectBuildError(() => activity(() => {}), 'MISSING_INPUTS');
  });

  it('raises MISSING_OUTPUTS when no exits', () => {
    expectBuildError(() => activity((a) => a.entry('in')), 'MISSING_OUTPUTS');
  });

  it('raises MISSING_NODES when no sub-nodes', () => {
    expectBuildError(() => activity((a) => {
      a.entry('in');
      a.exit('done');
    }), 'MISSING_NODES');
  });

  it('raises UNUSED_PORT when entry is not wired', () => {
    expectBuildError(() => activity((a) => {
      a.entry('in');
      a.exit('done');
      a.addNode('s', step(async () => {}));
      a.wire('s.success', '.done');
      a.wire('s.failure', '.done');
    }), 'UNUSED_PORT');
  });

  it('raises UNUSED_PORT when exit is not target of any wire', () => {
    expectBuildError(() => activity((a) => {
      a.entry('in');
      a.exit('done');
      a.exit('orphan');
      a.addNode('s', step(async () => {}));
      a.wire('.in', 's.success');
      a.wire('s.success', '.done');
      a.wire('s.failure', '.done');
    }), 'UNUSED_PORT');
  });

  it('raises UNUSED_PORT when sub-node output is not wired', () => {
    expectBuildError(() => activity((a) => {
      a.entry('in');
      a.exit('done');
      a.addNode('s', step(async () => {}));
      a.wire('.in', 's.success');
      a.wire('s.success', '.done');
      // missing wire for s.failure
    }), 'UNUSED_PORT');
  });

  it('raises UNREACHABLE_NODE for sub-node with no incoming wire', () => {
    expectBuildError(() => activity((a) => {
      a.entry('in');
      a.exit('done');
      a.addNode('s', step(async () => {}));
      a.addNode('orphan', step(async () => {}));
      a.wire('.in', 's.success');
      a.wire('s.success', '.done');
      a.wire('s.failure', '.done');
      a.wire('orphan.success', '.done');
      a.wire('orphan.failure', '.done');
    }), 'UNREACHABLE_NODE');
  });
});

describe('activity convergence', () => {
  it('allows multiple wires to the same exit', async () => {
    const wf = activity((a) => {
      a.entry('in');
      a.exit('done');
      a.addNode('check', atom(async (ctx) => ctx.v > 0 ? 'pos' : 'neg', { outputs: ['pos', 'neg'] }));
      a.wire('.in', 'check.in');
      a.wire('check.pos', '.done');
      a.wire('check.neg', '.done');
    });
    const r1 = await flow('f', wf).run({ v: 1 }, { logger: noLog });
    expect(r1.exit).toBe('done');
    const r2 = await flow('f', wf).run({ v: -1 }, { logger: noLog });
    expect(r2.exit).toBe('done');
  });
});

describe('activity runtime', () => {
  it('walks from entry to exit through wires', async () => {
    const wf = activity((a) => {
      a.entry('in');
      a.addNode('a', step(async (ctx) => { ctx.a = 1; }));
      a.addNode('b', step(async (ctx) => { ctx.b = 2; }));
      a.exit('done');
      a.wire('.in', 'a.success');
      a.wire('a.success', 'b.success');
      a.wire('a.failure', '.done');
      a.wire('b.success', '.done');
      a.wire('b.failure', '.done');
    });
    const r = await flow('f', wf).run({}, { logger: noLog });
    expect(r.exit).toBe('done');
    expect(r.ctx.a).toBe(1);
    expect(r.ctx.b).toBe(2);
  });

  it('reuses sub-node across positions with independent locals', async () => {
    const counter = step(async (_ctx, local) => {
      local.n = (local.n ?? 0) + 1;
    });
    const wf = activity((a) => {
      a.entry('in');
      a.addNode('a', counter);
      a.addNode('b', counter);
      a.exit('done');
      a.wire('.in', 'a.success');
      a.wire('a.success', 'b.success');
      a.wire('a.failure', '.done');
      a.wire('b.success', '.done');
      a.wire('b.failure', '.done');
    });
    const r = await flow('f', wf).run({}, { logger: noLog });
    expect(r.exit).toBe('done');
    // Both positions had cycle 1 (independent locals).
    const cycles = r.trace.filter((t) => t.path.length === 1).map((t) => t.cycle);
    expect(cycles).toEqual([1, 1]);
  });

  it('supports cycle wires (retry loop)', async () => {
    const wf = activity((a) => {
      a.entry('in');
      a.addNode('try', atom(async (ctx, local) => {
        local.n = (local.n ?? 0) + 1;
        if (local.n >= 3) { ctx.tries = local.n; return 'ok'; }
        return 'retry';
      }, { outputs: ['ok', 'retry'] }));
      a.exit('done');
      a.wire('.in', 'try.in');
      a.wire('try.retry', 'try.in');
      a.wire('try.ok', '.done');
    });
    const r = await flow('f', wf).run({}, { logger: noLog });
    expect(r.exit).toBe('done');
    expect(r.ctx.tries).toBe(3);
    // Three trace entries for `try` (cycles 1, 2, 3) plus the outer activity entry.
    const tryEntries = r.trace.filter((t) => t.path.join('.') === 'try');
    expect(tryEntries.map((t) => t.cycle)).toEqual([1, 2, 3]);
  });

  it('top-level path is empty array []', async () => {
    const wf = activity((a) => {
      a.entry('in');
      a.addNode('s', step(async () => {}));
      a.exit('done');
      a.wire('.in', 's.success');
      a.wire('s.success', '.done');
      a.wire('s.failure', '.done');
    });
    const r = await flow('f', wf).run({}, { logger: noLog });
    // The top-level activity entry is pushed first (pre-order DFS).
    expect(r.trace[0].path).toEqual([]);
    expect(r.trace[0].kind).toBe('activity');
  });

  it('sub-node paths extend the parent path', async () => {
    const inner = activity((a) => {
      a.entry('in');
      a.addNode('x', step(async () => {}));
      a.exit('done');
      a.wire('.in', 'x.success');
      a.wire('x.success', '.done');
      a.wire('x.failure', '.done');
    });
    const outer = activity((a) => {
      a.entry('in');
      a.addNode('child', pin(inner, 'in'));
      a.exit('done');
      a.wire('.in', 'child.in');
      a.wire('child.done', '.done');
    });
    const r = await flow('f', outer).run({}, { logger: noLog });
    const paths = r.trace.map((t) => t.path.join('.'));
    expect(paths).toContain('child.x');
  });
});
