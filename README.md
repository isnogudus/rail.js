# rail.js

A small workflow library for JavaScript. Express business logic as a
**graph of named nodes** with explicit named outputs, validated at
build time and traced at runtime.

- Plain ES modules + JSDoc — **no runtime dependencies**, no build step
- Async end to end
- Five atomic builders (`atom`, `nstep`, `step`, `pass`, `fail`),
  three group builders (`activity`, `nrail`, `railway`,
  plus the concurrent `parallel`), and one wrapper (`pin`)
- Eager build-time validation: every builder fully validates its
  result before returning. Errors raise `RailBuildError` at the
  offending builder call.
- Cycles in the wire graph are valid — retry / poll / iteration
  patterns model as normal graph topology, bounded by the step budget.
- Position-local state (`local`) on every node, hierarchical for
  group nodes (`local.children[subName]`, `local.branches[branchName]`).
- Mermaid render for documentation and debugging.
- Pluggable logger and synchronous tracer (`begin` / `end` events)
  for live observation.
- Cooperative cancellation (`opts.signal`) and a hard kill switch
  (`opts.killSignal`).
- Runs unchanged in **Node 22+**, modern browsers, and **QuickJS** —
  cancellation gracefully degrades when `AbortController` is absent
  from the host environment.
- Custom node kinds are first-class via `__rail_type__: 'node'` and
  the exported `invokeNode` extension API.

The full specification lives in [`docs/rail-spec.md`](./docs/rail-spec.md);
the deployed site at <https://isnogudus.github.io/rail.js/> includes a
[rendered spec page](https://isnogudus.github.io/rail.js/spec.html) and
live demos for [Railway](https://isnogudus.github.io/rail.js/#railway),
[n-Rail](https://isnogudus.github.io/rail.js/#nrail), and
[Activity](https://isnogudus.github.io/rail.js/#activity). The
[`CHANGELOG.md`](./CHANGELOG.md) documents version-to-version changes.
This README is the practical guide.

## Install

### From npm

```sh
npm install @isnogudus/rail.js
```

### From a GitHub release (browser, no bundler)

Each tagged release attaches two pre-built ESM bundles as release
assets. Import them directly in a browser:

```html
<script type="module">
  // ~23 KB minified, ~7 KB gzipped
  import { railway, flow } from
    'https://github.com/isnogudus/rail.js/releases/download/v0.3.0/rail.min.js';

  const wf = railway((r) => {
    r.step('hello', async (ctx) => { ctx.greeted = true; });
  });

  const r = await flow('demo', wf).run({});
  console.log(r.exit, r.ctx);
</script>
```

Use `rail.js` instead of `rail.min.js` for the readable build (~44 KB)
when debugging. Pin to a specific tag (`v0.3.0`) to lock the version.

### From a CDN

```html
<script type="importmap">
  {
    "imports": {
      "rail.js": "https://cdn.jsdelivr.net/gh/isnogudus/rail.js@v0.3.0/rail.js"
    }
  }
</script>
<script type="module">
  import { railway, flow } from 'rail.js';
</script>
```

ESM only. Engines: **Node 22+**, **modern browsers**, **QuickJS**.
Cancellation needs `AbortController` / `AbortSignal` — present in
Node ≥ 19 and modern browsers; **absent in vanilla QuickJS**. The
library detects this and runs without cancellation in that case:
`runInfo.signal` is `undefined`, `opts.killSignal` has no effect, and
parallel sibling-aborts are no-ops. Everything else (atomic builders,
activity, nrail, railway, parallel-with-merge, cycles, local state,
tracer, logger) is engine-independent.

A smoke test exists at [`test-quickjs.js`](./test-quickjs.js); run it
with `npm run test:qjs` if you have a `qjs` binary on PATH.

## Quick start

```js
import { activity, step, flow } from '@isnogudus/rail.js';

const greet = activity((a) => {
  a.entry('in');
  a.addNode('say', step(async (ctx) => {
    ctx.message = `hello, ${ctx.name}`;
  }));
  a.exit('done');
  a.wire('.in',          'say.success');
  a.wire('say.success',  '.done');
  a.wire('say.failure',  '.done');
});

const result = await flow('greet', greet).run({ name: 'world' });
// → { exit: 'done', ctx: { name: 'world', message: 'hello, world' }, trace: [...] }
```

For more, see:

- [`example.js`](./example.js) — `npm run example` — overview demo
- [`examples/`](./examples/) — `npm run examples` — focused runnable
  files for each pattern:

  | File | Concept |
  |------|---------|
  | [01-greet.js](./examples/01-greet.js) | minimal happy-path activity (§14.1) |
  | [02-subactivity.js](./examples/02-subactivity.js) | sub-activity composition (§14.3) |
  | [03-multi-input.js](./examples/03-multi-input.js) | multi-entry inner activity used through `pin` |
  | [04-build-error.js](./examples/04-build-error.js) | `RailBuildError` from the builder (§14.4) |
  | [05-shared-node.js](./examples/05-shared-node.js) | reusing a node under multiple names (§14.8) |
  | [06-toplevel-step.js](./examples/06-toplevel-step.js) | top-level atomic node (§14.7) |
  | [07-unhandled-throw.js](./examples/07-unhandled-throw.js) | `UNHANDLED_THROW` (§14.9) |
  | [08-cancellation.js](./examples/08-cancellation.js) | cooperative cancellation + kill signal (§14.10) |
  | [09-custom-logger.js](./examples/09-custom-logger.js) | custom logger (§14.11) |
  | [10-tracer.js](./examples/10-tracer.js) | `(entry, event)` tracer (§14.12) |
  | [11-parallel-merge.js](./examples/11-parallel-merge.js) | `parallel(branches, merge?)` (§14.5) |
  | [12-nrail.js](./examples/12-nrail.js) | `nrail` with rails and cleanup (§14.14) |
  | [13-mermaid.js](./examples/13-mermaid.js) | Mermaid render (LR / TB) |
  | [14-retry-loop.js](./examples/14-retry-loop.js) | retry loop with cycle + `local` (§14.13) |
  | [15-concurrent-runs.js](./examples/15-concurrent-runs.js) | stateless flow + concurrent runs |
  | [16-railway.js](./examples/16-railway.js) | `railway` two-track pipeline (§14.15) |
  | [17-nrail-labels.js](./examples/17-nrail-labels.js) | `nrail` labels + links (backward + forward) (§6.11) |
  | [18-aggregate-error.js](./examples/18-aggregate-error.js) | `RailAggregateError` from `parallel` (§8, §12.4) |
  | [19-custom-kind.js](./examples/19-custom-kind.js) | custom node kind via `invokeNode` (§2, §15.3) |
  | [20-nstep.js](./examples/20-nstep.js) | `nstep` string-or-array + nullish-return (§3.2) |

## Concepts at a glance

| Concept | Has | Built via |
|---------|-----|-----------|
| **Node** | `__rail_type__: 'node'`, `__rail_kind__`, `inputs`, `outputs`, `_invoke` | `atom`/`nstep`/`step`/`pass`/`fail`, `pin`, `parallel` |
| **Activity** (`'activity'`) | sub-nodes connected by wires | `activity(builder)`, `nrail(builderFn)`, `railway(builderFn)` |
| **Parallel** (`'parallel'`) | branches + optional merge node | `parallel(branches, merge?)` |
| **Pin** (`'pin'`) | a single inner node, transparent in the trace | `pin(node, entry)` |
| **Flow** | a top-level node + a name | `flow(name, node)` |

| Term | Meaning |
|------|---------|
| **Wire** | A directed connection from a source endpoint (entry or sub-node output) to a target endpoint (exit or sub-node input). Written as a string: `'.entry'`, `'.exit'`, `'subName.port'`. |
| **`ctx`** | The user-domain context. Flows by reference; user functions mutate it in place. `parallel` produces a `{ branchName: branchCtx }` aggregate. |
| **`local`** | Per-position mutable storage; hierarchical for group nodes. `local._cycles` is the invocation count at the position. |
| **`runInfo`** | Read-only context for atomic user functions: `{ signal, flowName, traceEntry }`. |

## Public API

```js
import {
  // Atomic builders (§3)
  atom, nstep, step, pass, fail,
  // User-function-level catch wrapper (§11)
  catchTo,
  // Wrapper (§4)
  pin,
  // Group builders (§5–§7)
  activity, nrail, railway,
  // Concurrent group (§8)
  parallel,
  // Flow (§9)
  flow,
  // Utilities (§10)
  isRailNode,
  // Extension API for custom kinds (§2, §15.3)
  invokeNode,
  // Errors (§12)
  RailError, RailBuildError, RailRuntimeError, RailAggregateError,
} from '@isnogudus/rail.js';
```

### Atomic builders

```js
// Primitive: user function returns the exit name as a string.
const myAtom = atom(async (ctx, local, runInfo) => {
  ctx.touched = true;
  return 'ok';
}, { outputs: ['ok', 'retry'] });

// String-or-array convenience + nullish-return for single-output.
const audit = nstep(async (ctx) => { /* no return needed */ }, 'in', 'ok');

// Railway success/failure pattern — throws routed to 'failure'.
const validate = step(async (ctx) => { if (!ctx.id) throw new Error('missing'); });

// Best-effort: throws caught and routed to the only exit.
const log    = pass(async (ctx) => { /* never affects control flow */ });
const report = fail(async (ctx) => { /* best-effort on the failure rail */ });
```

`step`, `pass`, and `fail` are built on `catchTo` (§11): they wrap
the user function with a catch that sets `ctx._error` and routes to a
fixed exit. `RailError` and `RailAggregateError` are always
re-thrown — they terminate the run.

### Activity (`activity(builder)`)

Wires are addressed by string references:

| String | Meaning |
|--------|---------|
| `'.entry'` | the activity's own entry named `entry` |
| `'.exit'`  | the activity's own exit named `exit`   |
| `'name.port'` | sub-node `name`'s port `port` (input or output, depending on whether the string is used as the target or the source) |

```js
const wf = activity((a) => {
  a.entry('in');
  a.exit('done');
  a.addNode('validate', step(validateFn));
  a.addNode('send',     step(sendFn));

  a.wire('.in',              'validate.success');
  a.wire('validate.success', 'send.success');
  a.wire('send.success',     '.done');
  a.wire('validate.failure', '.done');
  a.wire('send.failure',     '.done');
});
```

Every builder method validates eagerly; the activity walks the
assembled graph once at the end of construction and raises
`RailBuildError` on missing wires, unreachable sub-nodes, etc.
The closure must be synchronous (`ASYNC_BUILDER` otherwise) and the
builder reference is sealed after the closure returns (`SEALED`).

### n-Rail (`nrail(builderFn)`) and Railway (`railway(builderFn)`)

`nrail` is a convenience factory for pipelines with multiple parallel
outcome tracks ("rails"). Steps consume and produce named rails; the
builder maintains a build-time Live-Set of open wires. `railway` is a
thin wrapper over `nrail` for two-track success/failure pipelines with
automatic `catchTo` wrapping.

```js
const orderPipeline = nrail((r) => {
  r.entry('main');
  r.step('validate', validateFn, 'main', ['main', 'fail']);
  r.step('charge',   chargeFn,   'main', ['main', 'retry', 'fail']);
  r.step('logRetry', logRetryFn, 'retry', 'fail');
  r.step('cleanup',  cleanupFn,  'fail', 'fail');
});

const sendMessage = railway((r) => {
  r.step('validate', async (ctx) => { if (!ctx.body) throw new Error('body'); });
  r.step('encrypt',  async (ctx, local, runInfo) => { /* ... */ });
  r.fail('logError', async (ctx) => { console.error(ctx._error); });
});
```

### Parallel (`parallel(branches, merge?)`)

Runs branches concurrently. Each branch receives a shallow copy of
`ctx` and its own `local` slot. After all branches resolve, the
parallel mutates the incoming `ctx` in place to the aggregated
`{ branchName: branchCtx }` shape. Without a merge node, the parallel
exits at `'out'`; with one, the merge node's outputs become the
parallel's outputs.

```js
const enrich = parallel({
  profile: fetchProfile,
  orders:  fetchOrders,
}, mergeResults);                       // optional merge node
```

If any branch rejects, sibling branches see `runInfo.signal.aborted`
via the combined signal and may exit cooperatively. After
`Promise.allSettled` collects all branches, the parallel throws a
`RailAggregateError` (single class regardless of how many branches
failed) with `branchErrors` keyed by branch name. The merge node is
not invoked when any branch fails.

### Cycles and `local`

Cycles in the wire graph are first-class:

```js
const retrier = activity((a) => {
  a.entry('in');
  a.addNode('fetch', atom(async (ctx, local) => {
    local.attempts = (local.attempts ?? 0) + 1;
    try { ctx.data = await fetch(ctx.url); return 'ok'; }
    catch (err) { return local.attempts < 3 ? 'retry' : 'giveUp'; }
  }, { outputs: ['ok', 'retry', 'giveUp'] }));
  a.exit('done');
  a.exit('failed');
  a.wire('.in',           'fetch.in');
  a.wire('fetch.ok',      '.done');
  a.wire('fetch.retry',   'fetch.in');   // cycle wire
  a.wire('fetch.giveUp',  '.failed');
});
```

The position's `local` persists across cycles within a single
`flow.run(...)`. `local._cycles` (written by `invokeNode`) counts the
invocations at this position. The run-global `maxSteps` budget
(default `1000`) bounds total node invocations.

### Errors

```
RailError
├── RailBuildError      INVALID_NAME, NOT_A_NODE, UNUSED_PORT, …
├── RailRuntimeError    UNHANDLED_THROW, UNKNOWN_OUTPUT_AT_RUNTIME,
│                       STEP_BUDGET_EXCEEDED, KILLED, INTERNAL
└── RailAggregateError  PARALLEL_BRANCH_FAILED  (branchErrors, errors[])
```

Use `err instanceof RailError` for the single membership test that
covers every library-produced error, single or aggregate. Library
errors do not carry the run trace or the ctx — register a tracer if
you need post-mortem state inspection.

### Cancellation

```js
const ctrl = new AbortController();
const result = await flow('myflow', wf).run({}, {
  signal:     ctrl.signal,        // cooperative — exposed as runInfo.signal
  killSignal: ctrl.signal,        // enforcing — invokeNode throws KILLED
});
```

`runInfo.signal` is the combined signal (caller's `signal` ∪ caller's
`killSignal` ∪ library's internal abort for parallel sibling failure).
Only the raw `killSignal` triggers `RailRuntimeError(KILLED)`.

### Tracer and logger

```js
await flow('f', node).run(ctx, {
  logger: (entry) => console.log(entry.path.join('.'), '->', entry.exit),
  tracer: (entry, event) => bus.emit(event, entry),  // 'begin' | 'end'
  loggerErrorPolicy: 'throw',     // default
  tracerErrorPolicy: 'swallow',   // default
});
```

The logger runs once per successfully completed step (after the
tracer's `'end'`). The tracer runs synchronously at `'begin'` and
`'end'`; pin is trace-transparent and emits nothing. Steps that throw
a library error have no `'end'` event — their TraceEntry remains
unfilled and the throw propagates.

### Mermaid

```js
const m1 = flow('myflow', node).toMermaid({ direction: 'LR' });
const m2 = wf.toMermaid('myActivity');           // directly on an activity node
```

Sub-activities render as nested subgraphs; `parallel` renders as a
`'parallel'`-labelled subgraph containing its branches and merge.
`pin` is transparent in the diagram.

## Distribution

Pure ES module, single entry point (`./rail.js`). Internal modules
under `rail/` are implementation detail.

```jsonc
{
  "type": "module",
  "main": "./rail.js",
  "exports": { ".": "./rail.js" }
}
```

No build step, no bundler, no TypeScript. Modern bundlers (Vite,
esbuild, webpack) consume the source directly.

## Scripts

| Script | What it does |
|--------|--------------|
| `npm test`           | Vitest run — 135 unit + integration tests against Node. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run test:qjs`   | Smoke-test against vanilla QuickJS (`qjs --std test-quickjs.js`). 50 assertions covering markers, trace shape, all builders, parallel + merge, aggregate-error, step budget, and the QuickJS-specific `runInfo.signal === undefined` contract. Requires `qjs` on PATH. |
| `npm run example`    | Run [`example.js`](./example.js) — overview demo (`railway`, `parallel + merge`, sub-`pin`, custom merge ctx). |
| `npm run examples`   | Run every file in [`examples/`](./examples/) sequentially via [`run-all.js`](./examples/run-all.js). |
| `npm run build`      | Produce `dist/rail.js` (~44 KB) and `dist/rail.min.js` (~23 KB / ~7 KB gzip) via esbuild. Used for release-asset bundles (see [the workflow](./.github/workflows/release.yml)). |
| `npm run site:sync`  | Copy the current `rail.js` + `rail/` + `docs/rail-spec.md` into `site/lib/` and `site/rail-spec.md` so the deployed site reflects local sources. |
| `npm run site:dev`   | Serve `site/` on `http://localhost:8080` via `python3 -m http.server`. |

## License

MIT
