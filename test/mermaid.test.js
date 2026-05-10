import { describe, it, expect } from 'vitest';
import { activity, node, parallel, catching, flow } from '../rail.js';

describe('Mermaid render (§3.11, acceptance #26-#29)', () => {
  it('flow.toMermaid() renders activity with all nodes and labelled edges (acceptance #26)', () => {
    const send = catching(node(() => 'ok', { outputs: ['ok'] }),
      { NetworkError: 'net5xx', AbortError: 'cancelled' });

    const sendMessage = activity((a) => {
      const start = a.entry('in');
      const { success, failure } = a.standardExits();
      const validate = a.addNode('validate', node(() => 'ok', { outputs: ['ok', 'invalid'] }));
      const encrypt = a.addNode('encrypt', node(() => 'ok', { outputs: ['ok', 'noKeys'] }));
      const sendN = a.addNode('send', send);
      a.wire(start, validate);
      a.wire(validate.out('ok'), encrypt);
      a.wire(validate.out('invalid'), failure);
      a.wire(encrypt.out('ok'), sendN);
      a.wire(encrypt.out('noKeys'), failure);
      a.wire(sendN.out('ok'), success);
      a.wire(sendN.out('net5xx'), failure);
      a.wire(sendN.out('cancelled'), failure);
    });
    sendMessage.compile();

    const m = flow('sendMessage', sendMessage).toMermaid();
    expect(m).toContain('flowchart LR');
    expect(m).toContain('start([in])');
    expect(m).toContain('"validate"');
    expect(m).toContain('"send"');
    // send has three labeled outgoing edges
    expect(m).toMatch(/n_send -- "ok" --> /);
    expect(m).toMatch(/n_send -- "net5xx" --> /);
    expect(m).toMatch(/n_send -- "cancelled" --> /);
    // exits with class
    expect(m).toContain('endExit_success');
    expect(m).toContain('endExit_failure');
    expect(m).toContain(':::exit');
    // No dotted edges
    expect(m).not.toMatch(/-\.->/);
    // No subActivity / parallelNode classes (since no sub-act / parallel here)
    expect(m).not.toContain(':::subActivity');
    expect(m).not.toContain(':::parallelNode');
  });

  it('renders sub-activity sub-node as subroutine + class (acceptance #27)', () => {
    const inner = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const s = a.addNode('s', node(() => 'ok', { outputs: ['ok'] }));
      a.wire(start, s);
      a.wire(s.out('ok'), ok);
    });
    const outer = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const i = a.addNode('inner', inner);
      a.wire(start, i);
      a.wire(i.out('ok'), ok);
    });
    outer.compile();
    const m = flow('w', outer).toMermaid();
    expect(m).toContain('n_inner[[inner]]:::subActivity');
  });

  it('renders parallel-node sub-node with parallelNode class (acceptance #28)', () => {
    const par = parallel({ a: node(() => 'ok', { outputs: ['ok'] }) });
    const wf = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      const fan = a.addNode('fan', par);
      a.wire(start, fan);
      a.wire(fan.out('done'), ok);
    });
    wf.compile();
    const m = flow('w', wf).toMermaid();
    expect(m).toContain('n_fan{{fan}}:::parallelNode');
  });

  it('flow.toMermaid() for top-level Step-Node renders minimal diagram (acceptance #29)', () => {
    const greet = node(() => ({ output: 'done', ctx: {} }), { outputs: ['done'] });
    greet.compile();
    const m = flow('greet', greet).toMermaid();
    expect(m).toContain('flowchart LR');
    expect(m).toContain('start([in])');
    expect(m).toContain('n_greet["greet"]');
    expect(m).toContain('endExit_done([done])');
    expect(m).toMatch(/n_greet -- "done" --> endExit_done/);
  });

  it('activity.toMermaid(name) labels with provided name', () => {
    const a = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      a.wire(start, ok);
    });
    a.compile();
    expect(a.toMermaid('greet')).toContain('flowchart LR');
  });

  it('opts.direction: TB switches direction', () => {
    const a = activity((a) => {
      const start = a.entry('in');
      const ok = a.exit('ok');
      a.wire(start, ok);
    });
    a.compile();
    expect(a.toMermaid('x', { direction: 'TB' })).toContain('flowchart TB');
  });
});
