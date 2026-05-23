# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version stays in the `0.x` range the public API may change between
minor versions; breaking changes are called out explicitly.

## [0.3.0] — 2026-05-23

Implementation of spec v0.3.0. This is a **major breaking** release: the entire
public API was redesigned. The library has been rewritten from scratch against
the new spec; v0.2 consumers cannot upgrade without code changes.

### Added

- **Five atomic builders** forming a clean hierarchy:
  - `atom(fn, { inputs?, outputs })` — the primitive; user fn returns the exit
    name as a string.
  - `nstep(fn, inputs, outputs)` — string-or-array normalisation; single-output
    nullish-return convenience.
  - `step(fn)` — railway success/failure; throws routed to `'failure'` via
    `catchTo` with `ctx._error` set.
  - `pass(fn)` / `fail(fn)` — best-effort steps on the success/failure rail
    respectively.
  - All five produce `__rail_kind__: 'atom'` nodes.
- **`catchTo(fn, exitName)`** — the sole exception-handling mechanism. A
  user-function-level wrapper; `step` / `pass` / `fail` / `railway` are built
  on it. `RailError` is always re-thrown.
- **`pin(node, entry)`** — wrapper that fixes one of a multi-entry node's
  inputs to expose a single-input view. Trace-transparent (no TraceEntry).
- **`nrail(builderFn)`** — declarative builder for n-rail pipelines.
  Steps consume/produce named rails; the builder tracks open wires via a
  build-time Live-Set. Labels and links (`r.label`/`r.link`) provide named
  anchors and arbitrary jumps for loops and forward references. Produces a
  standard activity.
- **`railway(builderFn)`** — thin wrapper over `nrail` for two-track
  success/failure pipelines with automatic `catchTo` wrapping.
- **Parallel merge node**: `parallel(branches, merge?)`. The optional merge
  node receives the aggregated `{ branchName: branchCtx }` ctx and chooses
  the parallel's exit; merge outputs become the parallel's outputs.
- **`RailAggregateError`** — single class produced by `parallel` on any
  branch rejection. Extends `RailError`. Carries `branchErrors` (keyed)
  and a derived `errors[]` view. Used uniformly even when only one branch
  rejected.
- **`invokeNode`** — exported as the public extension API for custom node
  kinds (any value with `__rail_type__: 'node'` and `_invoke`).
- **Hierarchical `local`** — `local.children[subName]` for activities,
  `local.branches[branchName]` (and `local._merge` for parallel with a
  merge node). Cycle counter is `local._cycles` (written by `invokeNode`).
- **`TraceEntry`** with `{ path, kind, cycle, entry, ctx, local, startTime,
  endTime?, exit? }`. `path` is an array, not a dotted string. No `error`
  field — library errors do not carry the trace.
- **Synchronous tracer** with `(entry, event)` where event is `'begin'` or
  `'end'`. Pin emits nothing (trace-transparent). Wrapped per
  `tracerErrorPolicy` (default `'swallow'`).
- **Sealing**: builder objects (`a`, `r`) raise `RailBuildError(SEALED)` on
  use after the closure returns.
- **`RailBuildError(ASYNC_BUILDER)`** when a group-builder closure returns
  a non-`undefined` value (typically a Promise from an `async` function).

### Removed

- **`node(fn, options)` factory**. Replaced by `atom`, `nstep`, `step`,
  `pass`, `fail`.
- **`check()` / `isChecked()` on nodes**. Validation is fully internal to
  the builders now — every builder returns a fully-validated node.
- **`catching(stepNode, mapping)` wrapper**. Replaced by `catchTo(fn, exit)`
  at the user-function level; multi-class routing is plain user code.
- **`merge(stepFn)` patch helper** and the typed-ctx utilities
  (`exceptionCtx`, `isExceptionCtx`, `isParallelCtx`, `ctxType`). Ctx
  conventions are now described in the spec (`_error`, parallel aggregate
  shape).
- **`RailCheckError`**. Folded into `RailBuildError` (single build-time
  error class).
- **`railKind` field on nodes**. Renamed to `__rail_kind__` (with
  `__rail_type__: 'node'` as the identification marker). Identification is
  by string markers, not `instanceof`.
- **Builder-handle-based wires** (`a.wire(start, validate.out('ok'))`).
  Replaced by string references: `a.wire('.in', 'validate.success')`.
  Position determines source vs target.
- **`a.standardExits()`**, `a.entry(name) → handle`, and handle objects in
  general. Builder methods now return nothing; references are strings.
- **Per-step `StepReturn` shape** (`{ output, ctx?, local? }`). User
  functions mutate `ctx` and `local` in place and return only the exit
  string.

### Changed

- **Invoke contract** — every node exposes `_invoke(entry, ctx, local,
  runState, path)` returning `Promise<string>`. The `path` argument is a
  `string[]` (top-level node has `path === []`; the flow name lives in
  `runState.flowName`).
- **Error hierarchy** — single root class `RailError` with three concrete
  subclasses (`RailBuildError`, `RailRuntimeError`, `RailAggregateError`).
  `err instanceof RailError` is the membership test for any library error.
- **Run result** — `{ exit, ctx, trace }` (was `{ terminus, ctx, trace }`).
  Library errors are thrown, never returned in the result.
- **Mermaid render** — sub-activities are nested `subgraph` blocks; parallel
  is a `'parallel'`-labelled subgraph; pin is transparent in the diagram.
  Label escaping follows the spec's HTML-entity rule.
- **Step budget** error code renamed `STEP_LIMIT_EXCEEDED` →
  `STEP_BUDGET_EXCEEDED`.

### Migration notes

There is no automatic migration from v0.2. A v0.2 → v0.3.0 port replaces
`node(...)` with one of the atomic builders, replaces handle-based wires
with string references, mutates ctx in place instead of returning it,
drops `check()`/`isChecked()`, and adjusts error catches to the unified
`RailError` hierarchy. See `examples/` for v0.3.0 idioms and the spec
(§19) for the full set of changes.

## [0.2.0] — 2026-05-11

Implementation of spec v0.2. This is a **breaking** release: the post-builder
validation is renamed (`compile` → `check`), structural builder errors now
raise eagerly at the call site, step functions gain a `local` parameter, and
cycles in the wire graph are valid topology.

### Added

- **`local` parameter on step functions.** Step signatures are now
  `(ctx, local, runInfo)`. `local` is a position-local workspace, persisted
  across invocations of the same position when the step explicitly returns a
  `local` field. Symmetric to `ctx`: read as a parameter, written via the
  `StepReturn`. Pre-initialised to `{}`; never `undefined`. Keyed by the full
  dotted path, so the same node instance at two different positions has two
  independent locals. See spec §4 / §9.13.
- **`runInfo.invocation` and `runInfo.path`.** `invocation` is the 1-based
  count of how often the current position has been entered in this run.
  `path` is the full dotted path of the current position. Both are intended
  for observability (logging, tracing, diagnostics) — for control flow use
  `local`.
- **Cycles are valid topology** (§7.4). The new `NO_EXIT_PATH` check
  (reverse-BFS from exits) replaces the previous `CYCLE` rejection: a node
  raises `NO_EXIT_PATH` only when it has no wire path to *any* exit. The
  retry pattern in §9.13 now passes `check()`.
- **`TraceEntry.invocation` and `TraceEntry.local`.** Every trace entry
  carries the invocation count and the outgoing `local` snapshot (or
  incoming on throw, since a throw produces no update).
- **Tracer events carry `invocation` and `local`.** Every
  `step-*`, `activity-*`, `branch-*` event includes both fields.
- **Default logger appends `#N` suffix** when `invocation > 1`.
- **Eager `INVALID_NAME` validation.** All user-supplied names (node, port,
  entry, exit, branch key, flow) are validated at the factory / builder call
  site; empty / whitespace-only / names containing `.` or `:` raise
  `RailBuildError(INVALID_NAME)` with a stack trace pointing at the offending
  line.
- **`flow.run()` auto-checks** the held node on the first run if
  `isChecked()` is `false`. `flow(name, node)` no longer requires a
  pre-checked node and never raises `NODE_NOT_COMPILED`.
- **Two-layer run-state.** Per-fork slots (`depth`, `currentInput`, `path`,
  `combinedSignal`) are scalar and copied on `{ ...runState }`. The `shared`
  sub-object (`stepCounter`, `cycleCounters`, `localState`, `maxSteps`,
  signals, logger, tracer, flow name, trace buffer) is held by reference and
  visible to all forks. Parallel-branch interleaving no longer trample
  per-fork values.
- **`local.test.js`** with 11 dedicated tests for the new mechanics.
- **Loop demo on the site** (§9 / Loop · local · cycle): `send` → `decide` →
  cycle back to `send`, using `decide.local.tries` for the retry budget.
- **Spec page on the site** (`spec.html`) — renders `docs/rail-spec.md` with
  a sticky TOC and scroll-spy. The Spec MD is now bundled into the site by
  `npm run site:sync`.

### Changed

- **`compile()` → `check()`**, `compiled()` → `isChecked()`,
  `RailCompileError` → `RailCheckError`. The two-phase contract is now
  `completeness` / `topology` (no separate `declaration` phase — those
  checks all moved to eager builder-time validation).
- **Builder methods raise `RailBuildError` synchronously** for what used to
  be `compile()`-time declaration errors:
  `MULTIPLE_ENTRIES`, `DUPLICATE_NODE`, `DUPLICATE_EXIT`,
  `MULTIPLE_OUTGOING_WIRES`, `MULTIPLE_ENTRY_WIRES`, `NOT_A_NODE`,
  `INVALID_NAME`. Stack traces point at the offending builder line.
- **`invoke` signature** is now
  `invoke(name, ctx, runState, local)` — uniform across Step-Node, Activity
  and Parallel-Node. Activities and Parallel-Nodes ignore `local` in v1 but
  the parameter is in the signature for invoke-contract uniformity.
- **`merge(stepFn)` signature** updated to `(ctx, local, runInfo)`.
- **Site diagram engine** ([site/diagrams.js](site/diagrams.js)) now
  disambiguates parallel wires between the same source/target pair by
  output-port label. Previously both wires shared one map slot and the
  animation always followed the last-defined wire. Trace grouping was also
  fixed to handle loops (one diagram step per trace entry instead of
  greedily collecting all matches into the first step).

### Removed

- **`RailCompileError`** export (replaced by `RailCheckError`).
- **`NODE_NOT_COMPILED` / `INVALID_FLOW_NAME`** error codes (replaced by
  auto-check / `INVALID_NAME`).
- **`CYCLE` topology check** (cycles are valid; `NO_EXIT_PATH` catches the
  structurally trapped case).

### Migration notes

```js
// before
import { compile, RailCompileError } from '@isnogudus/rail.js';
flow.compile();
if (!flow.compiled()) flow.compile();

// after
import { RailCheckError } from '@isnogudus/rail.js';
flow.check();
if (!flow.isChecked()) flow.check();   // or just call flow.run() — auto-checks
```

```js
// step function — local is the new second parameter
async function send(ctx, local, runInfo) {
  // local.tries persists across invocations of THIS position
  const tries = (local.tries ?? 0) + 1;
  // ...
  return { output: 'ok', local: { tries } };
}
```

## [0.1.0] — 2026-04

Initial release: spec v0.1 implementation with `compile()`, three-phase
validation, no cycles. See git history for details.
