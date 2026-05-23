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
