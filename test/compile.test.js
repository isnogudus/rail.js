import { describe, it, expect } from 'vitest';
import { activity, node, RailBuildError, RailCheckError } from '../rail.js';

function checkExpect(act, phase, codes) {
  try {
    act.check();
    throw new Error('expected RailCheckError');
  } catch (e) {
    expect(e).toBeInstanceOf(RailCheckError);
    expect(e.phase).toBe(phase);
    const seen = e.errors.map((x) => x.code);
    for (const code of codes) expect(seen).toContain(code);
    return e;
  }
}

function buildExpect(fn, code) {
  try {
    fn();
    throw new Error('expected RailBuildError');
  } catch (e) {
    expect(e).toBeInstanceOf(RailBuildError);
    expect(e.code).toBe(code);
    return e;
  }
}

describe('Eager build-time validation (§7.1)', () => {
  it('MULTIPLE_ENTRIES raised synchronously by a.entry()', () => {
    buildExpect(() => activity((a) => {
      a.entry('in');
      a.entry('alt');
    }), 'MULTIPLE_ENTRIES');
  });

  it('DUPLICATE_NODE raised synchronously by a.addNode()', () => {
    buildExpect(() => activity((a) => {
      a.entry('in');
      a.exit('ok');
      a.addNode('s', node(() => 'ok', { outputs: ['ok'] }));
      a.addNode('s', node(() => 'ok', { outputs: ['ok'] }));
    }), 'DUPLICATE_NODE');
  });

  it('DUPLICATE_EXIT raised synchronously by a.exit()', () => {
    buildExpect(() => activity((a) => {
      a.entry('in');
      a.exit('ok');
      a.exit('ok');
    }), 'DUPLICATE_EXIT');
  });

  it('NOT_A_NODE raised synchronously by a.addNode()', () => {
    buildExpect(() => activity((a) => {
      a.entry('in');
      a.exit('ok');
      a.addNode('bad', /** @type {any} */ ({}));
    }), 'NOT_A_NODE');
  });

  it('MULTIPLE_OUTGOING_WIRES raised synchronously by a.wire()', () => {
    buildExpect(() => activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const s = a.addNode('s', node(() => 'ok', { outputs: ['ok'] }));
      a.wire(start, s);
      a.wire(s.out('ok'), ok);
      a.wire(s.out('ok'), ok);   // ← second outgoing from same output
    }), 'MULTIPLE_OUTGOING_WIRES');
  });

  it('MULTIPLE_ENTRY_WIRES raised synchronously by a.wire()', () => {
    buildExpect(() => activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      a.wire(start, ok);
      a.wire(start, ok);
    }), 'MULTIPLE_ENTRY_WIRES');
  });

  it('INVALID_NAME for empty/whitespace/reserved-char names', () => {
    buildExpect(() => activity((a) => a.entry('')), 'INVALID_NAME');
    buildExpect(() => activity((a) => a.entry('   ')), 'INVALID_NAME');
    buildExpect(() => activity((a) => a.entry('with.dot')), 'INVALID_NAME');
    buildExpect(() => activity((a) => a.entry('with:colon')), 'INVALID_NAME');
  });
});

describe('Activity check — completeness (§7.3)', () => {
  it('NO_ENTRY when no entry declared', () => {
    const a = activity((a) => {
      const ok = a.exit('ok');
      const s = a.addNode('s', node(() => 'ok', { outputs: ['ok'] }));
      a.wire(s.out('ok'), ok);
    });
    checkExpect(a, 'completeness', ['NO_ENTRY']);
  });

  it('NO_EXITS when no exit declared', () => {
    const a = activity((a) => { a.entry('in'); });
    checkExpect(a, 'completeness', ['NO_EXITS']);
  });

  it('ENTRY_NOT_WIRED', () => {
    const a = activity((a) => {
      a.entry('in');
      a.exit('ok');
    });
    checkExpect(a, 'completeness', ['ENTRY_NOT_WIRED', 'EXIT_NOT_WIRED']);
  });

  it('UNWIRED_OUTPUT', () => {
    const a = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const s = a.addNode('s', node(() => 'ok', { outputs: ['ok', 'bad'] }));
      a.wire(start, s);
      a.wire(s.out('ok'), ok);
    });
    checkExpect(a, 'completeness', ['UNWIRED_OUTPUT']);
  });

  it('EXIT_NOT_WIRED', () => {
    const a = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      a.exit('alt'); // not wired
      const s = a.addNode('s', node(() => 'ok', { outputs: ['ok'] }));
      a.wire(start, s);
      a.wire(s.out('ok'), ok);
    });
    checkExpect(a, 'completeness', ['EXIT_NOT_WIRED']);
  });

  it('Unwired INPUTS are NOT an error (asymmetric to UNWIRED_OUTPUT, §7.3 note)', () => {
    const a = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const s = a.addNode('s', node(() => 'ok', { inputs: ['main', 'side'], outputs: ['ok'] }));
      a.wire(start, s.in('main'));
      a.wire(s.out('ok'), ok);
    });
    expect(() => a.check()).not.toThrow();
  });

  it('Convergence: multiple wires into same node-input is allowed (§7.5)', () => {
    const a = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const t = a.addNode('t', node((c) => ({ output: c.choice, ctx: c }),
        { outputs: ['a', 'b'] }));
      const merge = a.addNode('merge', node(() => 'ok', { outputs: ['ok'] }));
      a.wire(start, t);
      a.wire(t.out('a'), merge);
      a.wire(t.out('b'), merge);
      a.wire(merge.out('ok'), ok);
    });
    expect(() => a.check()).not.toThrow();
  });
});

describe('Activity check — topology (§7.4)', () => {
  it('UNREACHABLE_NODE', () => {
    const a = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const s1 = a.addNode('s1', node(() => 'ok', { outputs: ['ok'] }));
      const s2 = a.addNode('s2', node(() => 'ok', { outputs: ['ok'] })); // unreachable
      a.wire(start, s1);
      a.wire(s1.out('ok'), ok);
      a.wire(s2.out('ok'), ok);
    });
    checkExpect(a, 'topology', ['UNREACHABLE_NODE']);
  });

  it('UNREACHABLE_EXIT (via separate dead node)', () => {
    const a = activity((a) => {
      const start = a.entry('in');
      const reach = a.exit('reach');
      const dead = a.exit('dead');
      const s = a.addNode('s', node(() => 'ok', { outputs: ['a'] }));
      const dummy = a.addNode('dummy', node(() => 'a', { outputs: ['a'] }));
      a.wire(start, s);
      a.wire(s.out('a'), reach);
      a.wire(dummy.out('a'), dead);
    });
    checkExpect(a, 'topology', ['UNREACHABLE_NODE', 'UNREACHABLE_EXIT']);
  });

  it('Cycles are valid topology (§9.13, acceptance #36)', () => {
    const a = activity((a) => {
      const start = a.entry('in');
      const { success, failure } = a.standardExits();
      const op = a.addNode('op', node((_c, local) => {
        const tries = (local.tries ?? 0) + 1;
        if (tries > 3) return { output: 'giveup', local: { tries } };
        return { output: tries === 2 ? 'ok' : 'retry', local: { tries } };
      }, { outputs: ['ok', 'retry', 'giveup'] }));
      a.wire(start, op);
      a.wire(op.out('retry'), op);
      a.wire(op.out('ok'), success);
      a.wire(op.out('giveup'), failure);
    });
    expect(() => a.check()).not.toThrow();
  });

  it('NO_EXIT_PATH: a closed cycle from which no output leaves (acceptance #37)', () => {
    const trapped = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const x = a.addNode('x', node(() => 'a', { outputs: ['a'] }));
      const y = a.addNode('y', node(() => 'a', { outputs: ['a'] }));
      const escape = a.addNode('escape', node(() => 'ok', { outputs: ['ok'] }));
      a.wire(start, x);
      a.wire(x.out('a'), y);
      a.wire(y.out('a'), x);          // closed cycle: no path to ok
      a.wire(escape.out('ok'), ok);   // 'escape' is unreachable
    });
    const err = checkExpect(trapped, 'topology', ['NO_EXIT_PATH']);
    const trappedNodes = err.errors
      .filter((e) => e.code === 'NO_EXIT_PATH')
      .map((e) => e.node)
      .sort();
    expect(trappedNodes).toEqual(['x', 'y']);
  });
});

describe('Check idempotence + memoization (§8.3, acceptance #21, #22)', () => {
  it('check() is idempotent', () => {
    const a = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const s = a.addNode('s', node(() => 'ok', { outputs: ['ok'] }));
      a.wire(start, s);
      a.wire(s.out('ok'), ok);
    });
    a.check();
    expect(a.isChecked()).toBe(true);
    expect(() => a.check()).not.toThrow();
    expect(a.isChecked()).toBe(true);
  });

  it('shared inner activity is checked exactly once across multiple uses', () => {
    let checkCount = 0;
    const inner = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const s = a.addNode('s', node(() => 'ok', { outputs: ['ok'] }));
      a.wire(start, s);
      a.wire(s.out('ok'), ok);
    });
    const origCheck = inner.check.bind(inner);
    inner.check = () => { checkCount++; origCheck(); };

    const outer1 = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const a1 = a.addNode('a1', inner);
      const a2 = a.addNode('a2', inner);
      a.wire(start, a1);
      a.wire(a1.out('ok'), a2);
      a.wire(a2.out('ok'), ok);
    });
    const outer2 = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const a3 = a.addNode('a3', inner);
      a.wire(start, a3);
      a.wire(a3.out('ok'), ok);
    });

    outer1.check();
    outer2.check();
    expect(inner.isChecked()).toBe(true);
    expect(checkCount).toBeGreaterThan(0);
  });

  it('outer check recursively checks unchecked inner (acceptance #2)', () => {
    const inner = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const s = a.addNode('encrypt', node(() => 'ok', { outputs: ['ok'] }));
      a.wire(start, s);
      a.wire(s.out('ok'), ok);
    });
    const outer = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const w = a.addNode('inner', inner);
      a.wire(start, w);
      a.wire(w.out('ok'), ok);
    });
    expect(inner.isChecked()).toBe(false);
    outer.check();
    expect(inner.isChecked()).toBe(true);
    expect(outer.isChecked()).toBe(true);
  });
});
