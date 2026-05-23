/**
 * Mermaid renderer smoke tests — spec §2.4.
 */

import { describe, expect, it } from 'vitest';
import { activity, step, parallel, pin, atom, flow } from '../rail.js';

describe('toMermaid', () => {
  it('renders an activity as a flowchart with entry, node, exit', () => {
    const wf = activity((a) => {
      a.entry('in');
      a.addNode('s', step(async () => {}));
      a.exit('done');
      a.wire('.in', 's.success');
      a.wire('s.success', '.done');
      a.wire('s.failure', '.done');
    });
    const m = wf.toMermaid('myAct');
    expect(m).toContain('flowchart LR');
    expect(m).toContain('"in"');
    expect(m).toContain('"s"');
    expect(m).toContain('"done"');
    expect(m).toContain('classDef exit');
  });

  it('flow.toMermaid delegates to activity toMermaid with flow name', () => {
    const wf = activity((a) => {
      a.entry('in');
      a.addNode('s', step(async () => {}));
      a.exit('done');
      a.wire('.in', 's.success');
      a.wire('s.success', '.done');
      a.wire('s.failure', '.done');
    });
    const m = flow('myflow', wf).toMermaid();
    expect(m).toContain('%% myflow');
  });

  it('escapes HTML special characters in labels', () => {
    const wf = activity((a) => {
      a.entry('a&b');
      a.addNode('s', step(async () => {}));
      a.exit('<done>');
      a.wire('.a&b', 's.success');
      a.wire('s.success', '.<done>');
      a.wire('s.failure', '.<done>');
    });
    const m = wf.toMermaid();
    expect(m).toContain('"a&amp;b"');
    expect(m).toContain('"&lt;done&gt;"');
  });

  it('renders sub-activity as a nested subgraph', () => {
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
    const m = outer.toMermaid();
    expect(m).toContain('subgraph');
    expect(m).toContain('"child"');
  });

  it('renders a flow holding an atom with a minimal diagram', () => {
    const n = atom(async () => 'ok', { outputs: ['ok'] });
    const m = flow('greet', n).toMermaid();
    expect(m).toContain('flowchart LR');
    expect(m).toContain('"in"');
    expect(m).toContain('"ok"');
  });

  it('renders parallel branches inside a subgraph', () => {
    const p = parallel({
      a: step(async () => {}),
      b: step(async () => {}),
    });
    const wf = activity((a) => {
      a.entry('in');
      a.addNode('par', p);
      a.exit('done');
      a.wire('.in', 'par.in');
      a.wire('par.out', '.done');
    });
    const m = wf.toMermaid();
    expect(m).toContain('subgraph');
    expect(m).toContain('"parallel"');
  });

  it('supports direction option', () => {
    const wf = activity((a) => {
      a.entry('in');
      a.addNode('s', step(async () => {}));
      a.exit('done');
      a.wire('.in', 's.success');
      a.wire('s.success', '.done');
      a.wire('s.failure', '.done');
    });
    expect(wf.toMermaid(undefined, { direction: 'TB' })).toContain('flowchart TB');
  });
});

describe('parallel.toMermaid stand-alone', () => {
  it('renders branches inside a single parallel subgraph (no merge)', () => {
    const p = parallel({
      profile: step(async () => {}),
      orders:  step(async () => {}),
    });
    const m = p.toMermaid('fan');
    expect(m).toContain('flowchart LR');
    expect(m).toContain('%% fan');
    expect(m).toContain('"parallel"');
    expect(m).toContain('"profile"');
    expect(m).toContain('"orders"');
    // No merge node, no convergent edges.
    expect(m).not.toContain('__merge__');
  });

  it('renders a merge node and wires every branch to it', () => {
    const m = parallel(
      { a: step(async () => {}), b: step(async () => {}) },
      atom(async () => 'ok', { outputs: ['ok'] }),
    ).toMermaid();
    expect(m).toContain('__merge__');
    // Two edges from branches to merge (single-line patterns).
    const arrows = m.split('\n').filter((l) => l.trim().endsWith('--> n3'));
    expect(arrows.length).toBeGreaterThanOrEqual(2);
  });

  it('renders a nested activity branch as a subgraph block', () => {
    const inner = activity((a) => {
      a.entry('in');
      a.addNode('x', step(async () => {}));
      a.exit('done');
      a.wire('.in', 'x.success');
      a.wire('x.success', '.done');
      a.wire('x.failure', '.done');
    });
    const m = parallel({ branchA: pin(inner, 'in'), branchB: step(async () => {}) }).toMermaid();
    // The activity branch is rendered as an inner subgraph;
    // the step branch as a plain box.
    expect(m).toContain('subgraph');
    expect(m).toContain('"branchA"');
    expect(m).toContain('"branchB"');
  });

  it('honours direction in stand-alone parallel render', () => {
    const p = parallel({ a: step(async () => {}) });
    expect(p.toMermaid(undefined, { direction: 'TB' })).toContain('flowchart TB');
  });
});

describe('label-escape rules (§2.4)', () => {
  it('escapes quotes, pipes, and replaces control chars with space', () => {
    const wf = activity((a) => {
      a.entry('with "quote"');
      a.addNode('s', step(async () => {}));
      a.exit('pipe|bar');
      a.exit('with\ttab');
      a.wire('.with "quote"', 's.success');
      a.wire('s.success', '.pipe|bar');
      a.wire('s.failure', '.with\ttab');
    });
    const m = wf.toMermaid();
    expect(m).toContain('"with &quot;quote&quot;"');
    expect(m).toContain('"pipe&vert;bar"');
    // Tab → space (control char rule).
    expect(m).toContain('"with tab"');
    // No raw tab/CR/LF leaked into label text:
    expect(m).not.toMatch(/"[^"]*\t[^"]*"/);
  });

  it('passes through Unicode beyond ASCII unchanged', () => {
    const wf = activity((a) => {
      a.entry('日本語');
      a.addNode('s', step(async () => {}));
      a.exit('✓done');
      a.wire('.日本語', 's.success');
      a.wire('s.success', '.✓done');
      a.wire('s.failure', '.✓done');
    });
    const m = wf.toMermaid();
    expect(m).toContain('"日本語"');
    expect(m).toContain('"✓done"');
  });
});
