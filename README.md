# rail.js

A small workflow library for JavaScript. Express business logic as a
**graph of named steps** with explicit named outputs, validated at
check time and traced at runtime.

- Plain ES modules + JSDoc — **no runtime dependencies**
- Async end to end
- Three node kinds: `step`, `activity`, `parallel`
- Eager build-time validation (`RailBuildError`) + post-builder
  `check()` with completeness and topology phases (`RailCheckError`)
- Cycles in the wire graph are valid — retry / poll / iteration
  patterns are modelled as normal graph topology
- Position-local state (`local`) on every step, symmetric to `ctx`
- Mermaid render for documentation and debugging
- Pluggable logger and structured tracer for live observation
- Cooperative cancellation (`AbortSignal`) and a hard kill switch
- Runs in modern Node and modern browsers (ESM)

The full specification lives in [`docs/rail-spec.md`](./docs/rail-spec.md);
the deployed site at <https://isnogudus.github.io/rail.js/> includes a
[rendered spec page](https://isnogudus.github.io/rail.js/spec.html) and
[live demos](https://isnogudus.github.io/rail.js/#demo). The
[`CHANGELOG.md`](./CHANGELOG.md) documents version-to-version changes.
This README is the practical guide.

## Install

```sh
npm install @isnogudus/rail.js
```

ESM only. Node 22+ recommended (Node 20+ should also work; AbortSignal
combination is implemented manually for portability).

## Quick start

```js
import { activity, node, flow } from '@isnogudus/rail.js';

const sendMessage = activity((a) => {
  const start = a.entry('in');
  const { success, failure } = a.standardExits();

  const validate = a.addNode('validate', node(async (ctx) => {
    if (!ctx.roomId) return 'invalid';
    return { output: 'ok', ctx: { ...ctx, validated: true } };
  }, { outputs: ['ok', 'invalid'] }));

  const send = a.addNode('send', node(async (ctx) => {
    // ... actual work ...
    return 'ok';
  }, { outputs: ['ok', 'failed'] }));

  a.wire(start,                   validate);
  a.wire(validate.out('ok'),      send);
  a.wire(validate.out('invalid'), failure);
  a.wire(send.out('ok'),          success);
  a.wire(send.out('failed'),      failure);
});

// flow.run() auto-checks on the first call; an explicit `.check()`
// is optional for early validation.
const sendMessageFlow = flow('sendMessage', sendMessage);

const result = await sendMessageFlow.run({ roomId: 'r-1' });
// → { ctx: { roomId: 'r-1', validated: true }, trace: [...], terminus: 'success' }
```

For runnable examples, see:

- [`example.js`](./example.js) — `npm run example` — overview demo
  (sendMessage + parallel + recover + Mermaid)
- [`examples/`](./examples/) — `npm run examples` — focused runnable
  files for each pattern:

  | File | Concept |
  |------|---------|
  | [01-greet.js](./examples/01-greet.js) | minimal happy-path activity (§9.1) |
  | [02-subactivity.js](./examples/02-subactivity.js) | sub-activity composition (§9.3) |
  | [03-multi-input.js](./examples/03-multi-input.js) | multi-input ports + `runInfo.input` |
  | [04-compile-error.js](./examples/04-compile-error.js) | check error reporting (§9.4) |
  | [05-shared-node.js](./examples/05-shared-node.js) | reusing a node under multiple names (§9.8) |
  | [06-toplevel-step.js](./examples/06-toplevel-step.js) | top-level Step-Node (§9.7) |
  | [07-graph-error.js](./examples/07-graph-error.js) | `RailRuntimeError` propagation (§9.9) |
  | [08-cancellation.js](./examples/08-cancellation.js) | cooperative cancellation (§9.10) |
  | [09-custom-logger.js](./examples/09-custom-logger.js) | custom logger (§9.11) |
  | [10-tracer.js](./examples/10-tracer.js) | structured tracer events (§9.12) |
  | [11-merge.js](./examples/11-merge.js) | `merge()` patch helper |
  | [12-typed-ctx.js](./examples/12-typed-ctx.js) | typed contexts + `ctxType` dispatch |
  | [13-mermaid.js](./examples/13-mermaid.js) | Mermaid render (LR / TB) |
  | [14-retry-loop.js](./examples/14-retry-loop.js) | retry loop with cycle + `local` (§9.13) |
  | [15-concurrent-runs.js](./examples/15-concurrent-runs.js) | stateless flow + concurrent `run(...)` |

## Concepts at a glance

| Term | Meaning |
|------|---------|
| **Node** | Plain object with `railKind`, `inputs`, `outputs`, `check()`, `isChecked()`, and `invoke(name, ctx, runState, local)`. Three built-in kinds: `step`, `activity`, `parallel`. |
| **Step-Node** (`railKind: 'step'`) | Wraps a user function. Created with `node(fn, { outputs })`. |
| **Activity** (`railKind: 'activity'`) | A graph of named sub-nodes with one entry and one or more exits. Created with `activity(builderFn)`. |
| **Parallel-Node** (`railKind: 'parallel'`) | Runs branches concurrently. Created with `parallel(branches)`. Always has output `'done'`. |
| **Flow** | Top-level runtime wrapper. Created with `flow(name, node)`. Stateless — `flow.run(...)` allocates a fresh run-state per call, and auto-checks the held node on first run. |
| **Wire** | A connection from a source endpoint (entry or node-output) to a target endpoint (exit or node-input). |
| **Terminus** | The output reached at the top level — exposed on `RunResult.terminus`. |
| **`local`** | A step's position-local workspace. Read as parameter, written via `StepReturn`, persisted per full path across invocations. |

## Public API

```js
import {
  // Node factories
  node, activity, parallel,
  // Step helpers
  merge, catching,
  // Runtime
  flow,
  // Typed-ctx helpers
  exceptionCtx, isExceptionCtx, isParallelCtx, ctxType,
  // Utilities
  isRailNode,
  // Errors
  RailBuildError, RailCheckError, RailRuntimeError,
} from '@isnogudus/rail.js';
```

### Step contract

A step is a function
`(ctx, local?, runInfo?) => StepReturn | Promise<StepReturn>`:

```ts
StepReturn =
  | string                                  // shorthand: this output; ctx + local unchanged
  | { output: string,
      ctx?:   object,                       // replaces running ctx if present
      local?: object }                      // replaces stored local if present
```

- **`ctx`** — the running ctx flowing through the workflow. Read it,
  return a new one (spread!), or omit to leave unchanged.
- **`local`** — the step's position-local workspace, pre-initialised to
  `{}`. Persisted per full path when the step explicitly returns a
  `local` field. Two positions of the same node instance have
  independent locals. Ideal for retry counters, polling state, etc.
- **`runInfo`** — `{ signal?, input, invocation, path }`. Library
  metadata: cancellation signal, activated input port name, 1-based
  invocation count for this position, and the full dotted path.
  Intended for observability — for control flow, use `local`.

### Retry / loop with `local`

Cycles are valid in the wire graph. A retry loop modelled directly as
graph topology, with the retry budget owned by the step:

```js
const op = a.addNode('op', node(async (ctx, local) => {
  const tries = (local.tries ?? 0) + 1;
  if (tries > 3) return { output: 'giveup', local: { tries } };
  const r = await unreliableCall(ctx);
  if (r.ok) return { output: 'ok', local: { tries } };
  return { output: 'retry', local: { tries } };
}, { outputs: ['ok', 'retry', 'giveup'] }));

a.wire(op.out('retry'),  op);          // ← cycle, valid
a.wire(op.out('ok'),     success);
a.wire(op.out('giveup'), failure);
```

`check()` accepts this topology. What makes the loop terminate is the
step's own logic, not graph structure. The `maxSteps` budget on
`flow.run(...)` is the runtime backstop for unbounded loops.

### Building activities

```js
activity((a) => {
  const start = a.entry('in');         // exactly one entry per activity
  const { success, failure } = a.standardExits();

  const v = a.addNode('validate', node(fn, { outputs: ['ok', 'bad'] }));

  a.wire(start,           v);          // entry → node
  a.wire(v.out('ok'),     success);    // node-output → exit
  a.wire(v.out('bad'),    failure);
});
```

Validation runs in two distinct moments:

- **Eagerly at the builder call site (`RailBuildError`)** — picks up
  structural mistakes the moment they happen, with a stack trace
  pointing at the offending line: `INVALID_NAME`, `UNKNOWN_PORT`,
  `NOT_A_NODE`, `INVALID_WIRE_DIRECTION`, `AMBIGUOUS_NODE_INPUT`,
  `WIRE_FROM_OTHER_BUILDER`, `MULTIPLE_ENTRIES`, `DUPLICATE_NODE`,
  `DUPLICATE_EXIT`, `MULTIPLE_OUTGOING_WIRES`, `MULTIPLE_ENTRY_WIRES`,
  `NO_ENTRY`, `CATCHING_REQUIRES_STEP`.

- **`check()` after the builder closure (`RailCheckError`)** —
  - **Completeness:** entry / node-output / exit wiring. Multiple wires
    into the same node-input are **convergence** and intentionally
    allowed (§7.5).
  - **Topology:** forward reachability from entry + backward
    reachability to any exit. `UNREACHABLE_NODE`, `UNREACHABLE_EXIT`,
    `NO_EXIT_PATH`. Cycles are valid (§7.4); only structurally trapped
    regions raise `NO_EXIT_PATH`.

`check()` is idempotent and recursive — sharing a node across
activities checks it exactly once. `flow.run(...)` invokes `check()`
automatically on the first call.

### Errors at runtime

`flow.run(...)` resolves with a `RunResult { ctx, trace, terminus }`
on success and rejects with a `RailRuntimeError` on a graph error
(`UNKNOWN_OUTPUT_AT_RUNTIME`, `UNHANDLED_THROW`, `STEP_LIMIT_EXCEEDED`,
`KILLED`, `LOGGER_FAILED`, `TRACER_FAILED`, `INVALID_SUB_NODE`,
`INTERNAL`). The error always carries `flow`, `trace`, `ctx`, and
optional `cause`.

The library does **not** offer exception-mapping. Steps that interact
with throwing code use `try`/`catch` themselves and either return a
named output or wrap the error with `exceptionCtx(...)` for downstream
inspection. The `catching(stepNode, mapping)` helper turns the
common `try`/`catch` boilerplate into a declarative wrapper.

### Cancellation

Two distinct mechanisms:
- **Cooperative (`opts.signal`)** — exposed to steps via
  `runInfo.signal`. The library performs no action on it itself;
  steps decide how to react.
- **Kill switch (`opts.killSignal`)** — checked by the runner before
  each node. If aborted, the run rejects with `RailRuntimeError(KILLED)`.

When both are passed, `runInfo.signal` is a derived signal that aborts
when either input does.

### Tracer (live observation)

Set `opts.tracer` to receive structured events at run / step /
activity / branch lifecycle points. Each scope has a start event and
either a success-end or a failure-end event. Every step / activity /
branch event carries `invocation` and the current `local` snapshot
alongside `step` / `name` and timing. See `docs/rail-spec.md` §6.8 for
the full event shape — useful for live UIs that want to visualise a
run as it happens.

### Mermaid

```js
const m = sendMessageFlow.toMermaid();           // flowchart LR
const m = sendMessageFlow.toMermaid({ direction: 'TB' });
const m = sendMessage.toMermaid('sendMessage');  // direct on the activity
```

Sub-activities render as subroutine shapes (`[[name]]:::subActivity`),
parallel-nodes as marker shapes (`{{name}}:::parallelNode`). Neither
is expanded inline in the diagram.

## Distribution

This is a pure ES module published with a single entry point
(`./rail.js`). The internal module split under `rail/` is an
implementation detail — only the symbols re-exported from `rail.js`
are part of the public API.

```jsonc
{
  "type": "module",
  "main": "./rail.js",
  "exports": { ".": "./rail.js" }
}
```

No build step, no bundler, no TypeScript. Modern bundlers (Vite,
esbuild, webpack) consume the source directly.

## License

MIT
