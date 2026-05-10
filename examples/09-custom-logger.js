/**
 * §9.11 — Custom logger.
 *
 * Pass a function `(entry: TraceEntry) => void` as `opts.logger` to
 * replace the default console output. The logger is called once per
 * step, after it finishes.
 */

import { activity, node, flow } from '../rail.js';

const wf = activity((a) => {
  const start = a.entry('in');
  const ok = a.exit('ok');
  const v = a.addNode('validate', node(
    (c) => ({ output: 'ok', ctx: { ...c, validated: true } }),
    { outputs: ['ok'] }
  ));
  const e = a.addNode('encrypt', node(
    (c) => ({ output: 'ok', ctx: { ...c, encrypted: true } }),
    { outputs: ['ok'] }
  ));
  a.wire(start,        v);
  a.wire(v.out('ok'),  e);
  a.wire(e.out('ok'),  ok);
});
wf.compile();

const lines = [];
const logger = (entry) => {
  const tag = entry.threw ? 'XX' : 'OK';
  lines.push(
    `[${tag}] depth=${entry.depth} ${entry.step.padEnd(12)} ` +
    `${entry.duration.toFixed(2)}ms -> ${entry.output ?? '(threw)'}`
  );
};

const r = await flow('wf', wf).run({}, { logger });
console.log(lines.join('\n'));
console.log('\nterminus:', r.terminus);
