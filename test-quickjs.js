/**
 * Smoke test for rail.js under QuickJS. Run with:
 *
 *   qjs --std test-quickjs.js
 *
 * QuickJS does not ship `AbortController` / `AbortSignal` by default —
 * runtimes like txiki.js add them, but the bare `qjs` CLI does not.
 * The library detects this and falls back to running without
 * cancellation: `runInfo.signal` is `undefined`, `opts.killSignal` is
 * ignored, and `parallel`'s internal sibling-abort is a no-op.
 * Everything else (atomic builders, activity, nrail, railway,
 * parallel with merge, cycles, local state, tracer, logger) works
 * unchanged.
 *
 * Exits with status 1 (via throw) if any assertion fails.
 */

import {
  atom, nstep, step, pass, fail, catchTo,
  pin, activity, nrail, railway, parallel,
  flow,
  isRailNode,
  RailError, RailBuildError, RailRuntimeError, RailAggregateError,
} from './rail.js';

let failed = 0;
let passed = 0;

function show(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

function assertEq(label, actual, expected) {
  const a = show(actual);
  const e = show(expected);
  if (a === e) { passed++; console.log(`  ok    ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}\n        expected ${e}\n        got      ${a}`); }
}

function assertTrue(label, cond) {
  if (cond) { passed++; console.log(`  ok    ${label}`); }
  else      { failed++; console.log(`  FAIL  ${label}`); }
}

const noLog = () => {};

// All test blocks are wrapped in `async function main()` because the
// `quickjs` apt package on Ubuntu (used by CI) ships QuickJS 2021-03-27,
// which does not parse top-level await. QuickJS-ng (≥ 2024) and Node
// happily run either form; this shape works in all three.
async function main() {

/* ---------------- markers + invoke contract ---------------- */
console.log('§16.1 markers + invoke contract');
{
  const n = atom(async () => 'ok', { outputs: ['ok'] });
  assertEq('atom.__rail_type__', n.__rail_type__, 'node');
  assertEq('atom.__rail_kind__', n.__rail_kind__, 'atom');
  assertEq('atom.inputs', n.inputs, ['in']);
  assertEq('atom.outputs', n.outputs, ['ok']);
  assertTrue('isRailNode', isRailNode(n));
  assertTrue('non-node rejected', !isRailNode({}));
}

/* ---------------- atom run + trace shape ---------------- */
console.log('§16.3 atom + trace shape');
{
  const n = atom(async (ctx) => { ctx.touched = true; return 'ok'; }, { outputs: ['ok'] });
  const r = await flow('atom', n).run({ pre: 1 }, { logger: noLog });
  assertEq('exit', r.exit, 'ok');
  assertEq('ctx.touched', r.ctx.touched, true);
  assertEq('trace.length', r.trace.length, 1);
  assertEq('trace[0].path', r.trace[0].path, []);
  assertEq('trace[0].kind', r.trace[0].kind, 'atom');
  assertEq('trace[0].cycle', r.trace[0].cycle, 1);
  assertEq('trace[0].entry', r.trace[0].entry, 'in');
  assertEq('trace[0].exit', r.trace[0].exit, 'ok');
  assertEq('trace[0].ctx snapshot (pre)', r.trace[0].ctx.pre, 1);
  assertTrue('trace[0].ctx snapshot pre-mutation', r.trace[0].ctx.touched === undefined);
}

/* ---------------- nstep nullish return ---------------- */
console.log('§16.5 nstep');
{
  const n = nstep(async (ctx) => { ctx.x = 1; }, 'in', 'ok');
  const r = await flow('ns', n).run({}, { logger: noLog });
  assertEq('nstep single-output nullish', r.exit, 'ok');
  assertEq('nstep ctx.x', r.ctx.x, 1);
}

/* ---------------- step / pass / fail + catchTo ---------------- */
console.log('§16.5 step/pass/fail + catchTo');
{
  const s = step(async (ctx) => { ctx.a = 1; });
  const r = await flow('s', s).run({}, { logger: noLog });
  assertEq('step.exit', r.exit, 'success');

  const sx = step(async () => { throw new Error('boom'); });
  const rx = await flow('s', sx).run({}, { logger: noLog });
  assertEq('step.throw.exit', rx.exit, 'failure');
  assertEq('step.throw._error.message', rx.ctx._error?.message, 'boom');

  const re = await flow('s', step(async () => { throw new RailRuntimeError('XX'); }))
    .run({}, { logger: noLog })
    .catch((e) => e);
  assertTrue('step re-throws RailError', re instanceof RailError);

  const fn = catchTo(async () => 'taken', 'fallback');
  const out = await fn({}, {}, {});
  assertEq('catchTo passes through string return', out, 'taken');
}

/* ---------------- pin ---------------- */
console.log('§16.6 pin');
{
  const inner = atom(async (_ctx, _l, runInfo) => runInfo.traceEntry.entry,
    { inputs: ['a', 'b'], outputs: ['a', 'b'] });
  const p = pin(inner, 'b');
  assertEq('pin.inputs', p.inputs, ['in']);
  assertEq('pin.outputs', p.outputs, ['a', 'b']);
  const r = await flow('p', p).run({}, { logger: noLog });
  assertEq('pin routes to inner entry', r.exit, 'b');
}

/* ---------------- activity ---------------- */
console.log('§16.7 activity');
{
  const wf = activity((a) => {
    a.entry('in');
    a.addNode('s', step(async (ctx) => { ctx.x = 'hit'; }));
    a.exit('done');
    a.wire('.in', 's.success');
    a.wire('s.success', '.done');
    a.wire('s.failure', '.done');
  });
  const r = await flow('act', wf).run({}, { logger: noLog });
  assertEq('activity.exit', r.exit, 'done');
  assertEq('activity.ctx.x', r.ctx.x, 'hit');
  assertEq('activity.trace.length', r.trace.length, 2);
  assertEq('activity.trace[0].path', r.trace[0].path, []);
  assertEq('activity.trace[1].path', r.trace[1].path, ['s']);
}

/* ---------------- nrail with Live-Set convergence ---------------- */
console.log('§16.9 nrail');
{
  const wf = nrail((r) => {
    r.entry('main');
    r.step('val',
      catchTo(async (ctx) => { if (!ctx.id) throw new Error('x'); return 'main'; }, 'fail'),
      'main', ['main', 'fail']);
    r.step('cleanup', async (ctx) => { ctx.cleaned = true; }, 'fail', 'fail');
  });
  assertEq('nrail.outputs', wf.outputs, ['main', 'fail']);
  const ok = await flow('nr', wf).run({ id: '1' }, { logger: noLog });
  assertEq('nrail.happy.exit', ok.exit, 'main');
  const bad = await flow('nr', wf).run({},        { logger: noLog });
  assertEq('nrail.fail.exit', bad.exit, 'fail');
  assertEq('nrail.fail.cleaned', bad.ctx.cleaned, true);
}

/* ---------------- nrail label/link loop ---------------- */
console.log('§6.11 nrail label/link loop');
{
  const wf = nrail((r) => {
    r.entry('main');
    r.label('start', 'main');
    r.step('try', async (_ctx, local) => {
      local.n = (local.n ?? 0) + 1;
      return local.n >= 3 ? 'main' : 'retry';
    }, 'main', ['main', 'retry']);
    r.link('start', 'retry');
  });
  const r = await flow('nl', wf).run({}, { logger: noLog });
  assertEq('nrail.loop.exit', r.exit, 'main');
  const tryCycles = r.trace.filter((t) => t.path.join('.') === 'try').map((t) => t.cycle);
  assertEq('nrail.loop.try cycles', tryCycles, [1, 2, 3]);
}

/* ---------------- railway ---------------- */
console.log('§16.10 railway');
{
  const wf = railway((r) => {
    r.step('a', async (ctx) => { ctx.a = 1; });
    r.fail('log', async (ctx) => { ctx.logged = ctx._error?.message ?? null; });
  });
  assertEq('railway.outputs', wf.outputs, ['success', 'failure']);
  const ok = await flow('rw', wf).run({}, { logger: noLog });
  assertEq('railway.happy', ok.exit, 'success');
  const wf2 = railway((r) => {
    r.step('boom', async () => { throw new Error('x'); });
    r.fail('log', async (ctx) => { ctx.logged = ctx._error?.message; });
  });
  const bad = await flow('rw', wf2).run({}, { logger: noLog });
  assertEq('railway.fail', bad.exit, 'failure');
  assertEq('railway.fail.logged', bad.ctx.logged, 'x');
}

/* ---------------- parallel + merge ---------------- */
console.log('§16.8 parallel + merge');
{
  const merge = atom(async (ctx) => {
    const a = ctx.a.a; const b = ctx.b.b;
    for (const k of Object.keys(ctx)) delete ctx[k];
    ctx.sum = a + b;
    return 'ok';
  }, { outputs: ['ok'] });
  const fan = parallel({
    a: atom(async (ctx) => { ctx.a = 10; return 'ok'; }, { outputs: ['ok'] }),
    b: atom(async (ctx) => { ctx.b = 32; return 'ok'; }, { outputs: ['ok'] }),
  }, merge);
  const r = await flow('par', fan).run({}, { logger: noLog });
  assertEq('parallel.exit', r.exit, 'ok');
  assertEq('parallel.sum', r.ctx.sum, 42);
}

/* ---------------- parallel branch failure ---------------- */
console.log('§16.8 parallel aggregate error');
{
  const fan = parallel({
    good: atom(async (ctx) => { ctx.ok = true; return 'ok'; }, { outputs: ['ok'] }),
    bad:  atom(async () => { throw new Error('boom'); }, { outputs: ['ok'] }),
  });
  const err = await flow('par2', fan).run({}, { logger: noLog }).catch((e) => e);
  assertTrue('aggregate is RailError', err instanceof RailError);
  assertTrue('aggregate is RailAggregateError', err instanceof RailAggregateError);
  assertEq('aggregate.code', err.code, 'PARALLEL_BRANCH_FAILED');
  assertEq('aggregate.failed branch', Object.keys(err.branchErrors), ['bad']);
}

/* ---------------- step budget ---------------- */
console.log('§16.12 step budget');
{
  const wf = activity((a) => {
    a.entry('in');
    a.addNode('spin', atom(async () => 'again', { inputs: ['in'], outputs: ['again', 'out'] }));
    a.exit('done');
    a.wire('.in', 'spin.in');
    a.wire('spin.again', 'spin.in');
    a.wire('spin.out', '.done');
  });
  const err = await flow('s', wf).run({}, { logger: noLog, maxSteps: 4 }).catch((e) => e);
  assertTrue('step budget is RailRuntimeError', err instanceof RailRuntimeError);
  assertEq('step budget code', err.code, 'STEP_BUDGET_EXCEEDED');
}

/* ---------------- runInfo.signal under QuickJS is undefined ---------------- */
console.log('runInfo.signal absent in qjs (no AbortController)');
{
  let seen = 'NOT-SET';
  const n = atom(async (_ctx, _l, runInfo) => { seen = runInfo.signal; return 'ok'; },
    { outputs: ['ok'] });
  await flow('sig', n).run({}, { logger: noLog });
  if (typeof AbortController === 'undefined') {
    assertEq('runInfo.signal is undefined under qjs', seen, undefined);
  } else {
    assertTrue('runInfo.signal exists when AC available', seen && typeof seen.aborted === 'boolean');
  }
}

  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) throw new Error(`${failed} smoke-test assertion(s) failed`);
}

main().catch((err) => {
  console.log('FATAL:', err?.message ?? String(err));
  // Unhandled rejection terminates the runtime with non-zero exit in
  // both QuickJS and Node — that's our CI signal.
  throw err;
});
