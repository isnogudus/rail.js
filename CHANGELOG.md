# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version stays in the `0.x` range the public API may change between
minor versions; breaking changes are called out explicitly.

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
