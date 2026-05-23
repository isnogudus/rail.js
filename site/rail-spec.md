# `rail.js` — Specification

**Spec version:** v0.3.0

A small workflow library for JavaScript. Plain JS with JSDoc, no dependencies, no persistence, no runtime magic. Workflows are explicit, validated graphs of named steps that you can render (Mermaid) and trace (log).

This document is the implementation spec. It is meant to be handed to an agent (Claude Code) as the source of truth for building the library. Code examples are illustrative — the agent should match the public API and semantics described here, not copy snippets verbatim.

---

## 1. Introduction

### 1.1 Goals

- Express business logic as a **graph of named nodes** with explicit **named outputs** ("exits").
- Catch structural errors at **build time**, not at run time.
- Provide a clear, useful **trace** for every run, with per-step timing and the taken exit. A run that terminates at an uncaught throw leaves the trace entry at the point of failure unfilled (no `endTime`, no `exit`); the error itself is delivered as the thrown value at the `flow.run` boundary, not on a trace entry.
- Render the graph as **Mermaid** for documentation and debugging.
- Stay **plain ES modules + JSDoc**, no TypeScript, no runtime dependencies.
- Run on **modern Node and modern browsers** with native ESM support, no build step required.
- Be **async** end to end.
- Compose: an activity can be embedded as a node in another activity (sub-activities).
- Support **parallel execution** of activities through a single, well-defined construct.
- Cleanly **separate node construction from node naming**: builders return context-free node values; the activity builder gives them names when adding them to a graph.
- Allow **convergence** (multiple wires ending at the same node-input) as a first-class topology, orthogonal to parallelism — see §5.3.
- Allow **cycles** in the wire graph for retry, poll, and iteration patterns — see §5.6 and §14.13.
- Allow **custom node kinds** as first-class participants. Any plain object that satisfies the Node interface (§2) can be a node; the framing helper `invokeNode` is exported as an extension API for custom-kind authors.

### 1.2 Non-goals

These are fundamental architectural decisions, not deferred features:

- **No persistence, no durable execution.** Runs are in-memory only; the library does not store `runState` to disk and there are no pause/resume semantics.
- **No distribution.** All nodes execute in a single JS realm. Cross-process or cross-worker dispatch is not in the design.
- **No framework integration.** rail.js is plain JS with no Svelte/React/etc. coupling. Tracing goes through a pluggable logger (default: `console.log`).
- **No fan-out via wire topology.** Parallelism is expressed through the `parallel(...)` library construct (§8), never by having multiple outgoing wires from the same source.
- **No streaming ctx.** Each invocation produces a single return value; chunked / streaming output from a node is not supported.

§17 gives concrete guidance for common patterns (retry, timeouts) that users implement themselves.

This document serves both as an implementation prompt for an automated code-generation agent and as a human-readable reference; the "why X" blocks throughout exist to preserve design rationale against both kinds of reader, and are informational rather than normative.

### 1.3 Relation to monadic pipelines

For readers with a functional-programming background: Rail graphs are a superset of monadic pipelines. A linear graph in which every node has two outputs (`success`/`failure`) is structurally `StateT` over `Either` — the same shape as Trailblazer's railway-oriented programming or `Result`-chains in Rust/Swift/F#. Monads, in this sense, are the special case of Rail graphs that happen to be linear and binary. Rail generalises in two directions: outputs can be n-ary instead of binary, and the composition is an explicit, validated graph rather than implicit `bind`-chaining.

---

### 1.4 Conceptual model

The library has three primary concepts: **Node**, **Activity**, and **Flow**, with a clear separation of concerns:

- A **Node** *is* something — it has an implementation and ports. It does not have a name; that is a property of its use.
- An **Activity** is a Node whose implementation is itself a graph of named sub-nodes connected by wires.
- A **Flow** is a runtime wrapper that holds a top-level Node, a top-level name, and `run(ctx, opts)` for execution. A flow is a thin handle around its held node; the node is still a graph of nodes and wires internally.

| Concept    | Has                                            | Does                                                            | Built via                                                |
|------------|------------------------------------------------|-----------------------------------------------------------------|----------------------------------------------------------|
| **Node**   | `_invoke`, `inputs`, `outputs`                 | Mutates ctx, returns one of its declared outputs                | `atom`/`nstep`/`step`/`pass`/`fail`, `pin`, `parallel`   |
| **Activity** | Sub-nodes and wires (a Node, kind `'activity'`) | Walks its sub-graph from entry to exit                          | `activity(builder)`, `nrail(builderFn)`, `railway(builderFn)` |
| **Flow**   | A top-level Node and a name                    | `run(ctx?, opts?) → Promise<RunResult>` or throws on library error | `flow(name, node)`                                       |

### 1.5 Library conventions

**Naming.** Library-plumbing slots on any rail value use a leading-underscore name (`_invoke`, `_inner`) — they are reachable by tooling and extension code but are not part of the user workflow API. User-facing methods follow normal camelCase (`toMermaid`). This distinction is by convention only; JavaScript does not enforce it.

**Identification.** Rail values are identified by string markers (`__rail_type__`, `__rail_kind__`), not by `instanceof`. This makes values cross-realm-safe (multiple loads of `rail.js` produce indistinguishable values) and removes any dependency on JavaScript class identity.

**Validation.** Every builder checks its structural conditions synchronously at the call site and raises `RailBuildError` immediately on violation. The stack trace therefore points at the offending builder call, not at a later run. Conditions that *cannot* be checked piecewise (cross-node topology, wire resolution) are deferred to a whole-graph walk that group builders run at the end of construction, just before returning the assembled node. Per-kind validation rules are documented in the kind's section (§3, §4, §5, §6, §7, §8). Custom-kind authors who construct nodes outside the built-in builders are responsible for their own consistency; the library does not validate custom kinds.

**Argument-shape errors are `TypeError`.** When a builder argument is of the wrong fundamental shape — `fn` is not a function, `options` is not a plain object, `branches` is not a plain object, and so on — the library raises a plain JS `TypeError`, not a `RailBuildError`. `RailBuildError` is reserved for semantic violations (invalid names, duplicates, missing required fields) that the library can only check once the arguments are of the expected shape.

**JavaScript semantics are normative.** Where the spec describes argument shapes, default values, type checks, or operator behaviour in prose, standard ECMAScript semantics apply unless explicitly stated otherwise. In particular:

- "Optional" and "defaults to X" mean: the default applies when the argument is `undefined` (or absent in a destructuring context). An explicit `null`, empty array, empty object, `0`, `''`, or `false` is a present value and is validated as such.
- "Plain object" means: a value where `typeof value === 'object' && value !== null` and not an Array, Map, Set, Date, RegExp, or similar built-in. The library does not perform `Object.getPrototypeOf` checks; the test is the one used in the validation sketches.
- "Function" means: `typeof value === 'function'`. Async functions, arrow functions, and regular functions are not distinguished.
- "Array" means: `Array.isArray(value) === true`.
- Equality comparisons are `===` unless noted.

**Concurrent runs.** Node values are immutable after construction; all per-run state lives in `runState` (§13.1) and in the per-run `local` tree owned by the top-level `flow.run` call (§2.3). The same node instance — and therefore the same flow — may participate in any number of concurrent runs without coordination. Sub-activities and sub-nodes reached by identity from multiple positions share no run-time state across positions either; each position has its own `local` slot.

---

## 2. Node

A **Node** is the unifying interface for elements in the graph: a single point with one or more named inputs (default `'in'`) and one or more named outputs, with an implementation that mutates the running ctx and chooses one of its declared outputs.

Concretely, a Node is **any plain object** with these properties:

- `__rail_type__: 'node'`, `__rail_kind__: string` — identification markers (§1.5). See Appendix A for the catalog of built-in kinds; external authors may use any string.
- `inputs: string[]` — declared input port names. Non-empty; names must be unique within the array and follow the rules in §5.1.
- `outputs: string[]` — declared output port names. Same rules as `inputs`.
- `_invoke(entry, ctx, local, runState, path)` — library-internal entry point. See §2.1 for the contract. Not part of the user API; the underscore is the convention.

A Node has **no** intrinsic name. Names are assigned when nodes are placed in a graph (`a.addNode(name, node)`) or held by a flow (`flow(name, node)`).

#### Node categories

Every node falls into one of three categories, by how it relates to other nodes:

- An **Atomic Node** has no sub-nodes. It performs its work by calling a user-supplied function and routes to one of its declared outputs. The only built-in atomic kind is `'atom'`; the `nstep`, `step`, `pass`, and `fail` factories all produce `'atom'` nodes — they differ only in how they wrap the user function before constructing the atom.
- A **Wrapper-Node** delegates its invocation to a single inner node, transforming parameters or result. It has no trace identity of its own: `invokeNode` is not called, no TraceEntry is pushed, `path` is not extended, no `local` slot is allocated, no tracer events are emitted. The inner node is exposed as the library-internal property `_inner`. The only built-in kind is `'pin'`.
- A **Group-Node** contains one or more sub-nodes and owns their local state via a hierarchical layout under its own `local`. Built-in kinds: `'activity'` (with `local.children[<subName>]`) and `'parallel'` (with `local.branches[<branchName>]`, plus `local._merge` if a merge node is configured).

The three categories are exhaustive and disjoint. Custom kinds follow the same classification by which contract they implement.

**Custom-kind responsibility.** Custom kinds that bypass the built-in builders are not subject to the library's validation. The author is responsible for building a node that satisfies the `_invoke` contract (§2.1) and exposes the required properties (`__rail_type__`, `__rail_kind__`, `inputs`, `outputs`). The library does not provide a validation hook for custom kinds; it does not introspect or test them at construction or at run time, beyond the marker check in `flow(...)`, `pin(...)`, `parallel(...)`, and `a.addNode(...)` (`isRailNode(node)` — see `RailBuildError(NOT_A_NODE)` in §12.2). Missing required properties on a `__rail_type__: 'node'` value surface as JS errors at first use, not as `RailBuildError`.

### 2.1 Invoke contract

Every Rail-Node has a single internal method on the node object — `_invoke`. The kind-specific work is performed by a separate `doInvoke` closure that the builder constructs; `_invoke` is a thin wrapper that calls `invokeNode(doInvoke, ...)` to compose them.

#### Signature

```js
async _invoke(entry, ctx, local, runState, path) → string
async invokeNode(doInvoke, kind, entry, ctx, local, runState, path) → string
async doInvoke(entry, ctx, local, runState, path, traceEntry) → string
```

All three are always async — the workflows this library targets involve I/O, external calls, and parallel branches; async is the natural shape of the work, not a design preference. The return value is the chosen exit name; ctx flows by reference (see "Return value" below).

#### Parameters

- `entry: string` — the chosen input port name. Must be one of `node.inputs[i]`. Determines which entry of the node is activated for this call.
- `ctx: Object` — the running context entering the node. This is user-domain data. The node may mutate it in place; mutations are visible to the caller (§2.2 "Mutation model"). Replace semantics are not provided — there is no return-channel for ctx.
- `local: Object` — the position-local state of this node, as supplied by the caller. A direct reference: the implementation may read and mutate it in place. The caller (typically the parent — a Group-Node such as Activity or Parallel, or the top-level runner) is responsible for preserving this reference across calls. If the caller wants to keep the local persistent at a position, it stores the same reference and passes it on every invocation.
- `runState: Object` — the run-global tool bag. Carries the trace, step counter, signals, tracer, logger, top-level flow name, step budget, and error policies. **The same object instance flows unchanged through the entire run.** Implementations do not fork or replace it; they may mutate its inner Maps and counters as described in "Side effects" below. See §13.1 for the full shape.
- `path: string[]` — the position of this node in the run, **relative to the top-level Flow**. An array of local names from the Flow's immediate sub-node down to this node (e.g. `['fan', 'branchA', 'validate']`). The Flow's name itself is not part of `path` — it lives in `runState.flowName`. For a top-level atomic node (Flow holds an `atom` directly), `path` is `[]`. The local registered name (if any) is `path[path.length - 1]`; the depth is `path.length`.

#### Return value (success)

A string: the chosen output port name. Must be an element of `node.outputs`. The caller follows the wire from this exit to the next node.

ctx flows through by reference; the node mutates the parameter rather than returning a replacement. `parallel` is the one place where ctx is replaced — it shallow-copies for each branch and overwrites the incoming ctx in place with the aggregated `{ branchName: branchCtx, ... }` shape after the branches resolve. If a merge node is configured, the parallel then invokes it with this aggregated ctx; the merge node can replace ctx again with a domain-shaped object and choose its own exit (§8, §15.6).

The `local` parameter is **not** in the return value either. Any changes the implementation makes to `local` are made through the reference passed in — inner mutation (`local.counter++`, `local.children[subName] = ...`) is visible to the caller via the same reference. There is no replacement mechanism: reassigning the parameter inside the implementation (`local = newObject`) has no effect on the caller, and the library does not provide a way to do so. If an implementation genuinely needs to replace a local entirely, it does so by in-place clear-and-rebuild — see §11 "Working with `local`".

In practice: Group-Nodes (Activity, Parallel) pass `local.children[subName]` (or `local.branches[branchName]` for Parallel) as the `local` parameter to each sub-call. Atomic builders pass `local` straight through to the user function as its second argument. The user function mutates the reference in place; the parent's storage already reflects those mutations as soon as the function returns. No write-back step is needed.

#### Failure

The library treats exceptions as bugs, not as a control-flow mechanism. The only values that may be thrown from any node in a well-formed run are:

- `RailError` (its concrete subclasses `RailRuntimeError`, `RailBuildError`).
- `RailAggregateError`.

Anything else escaping a node is a programming error — a domain exception that should have been modelled as a named output, or an unexpected bug.

**Where non-library throws are caught.** Two places in the runtime catch non-library throws and produce `RailRuntimeError(UNHANDLED_THROW)`:

- **`flow.run`** (§9) wraps its top-level `_invoke` call in a `try/catch`. A non-library throw escaping the top-level node is wrapped as `RailRuntimeError(UNHANDLED_THROW)` with the original error as `cause`.
- **`parallel`** (§8) uses `Promise.allSettled` to collect every branch's outcome. A non-library rejection from a branch is wrapped as `RailRuntimeError(UNHANDLED_THROW)` per branch before being placed into the aggregate's `errors[]` (so `errors[]` is always `(RailError | RailAggregateError)[]`). The aggregate itself is a `RailAggregateError`, not an `UNHANDLED_THROW`.

Everywhere else, non-library throws propagate by natural JS exception propagation: `activity.doInvoke` does not catch, `invokeNode` rethrows without further trace bookkeeping (the entry stays in the trace with only `startTime` set, marking the position where the run died), and `pin` is a transparent wrapper. Throws that reach the flow root terminate the run.

#### Preconditions

Direct calls to `_invoke` from outside the library — typically from custom-kind code — are the caller's responsibility. The library does not defend against misuse here: a custom kind that fails to construct its inputs/outputs/`_invoke` consistently will produce undefined runtime behaviour or errors deeper in the call chain. The built-in builders (§1.5, plus per-kind validation in §3, §4.1, §5.6, §6.10, §7.5, §8.1) construct nodes that satisfy all `_invoke` preconditions by construction.

#### Side effects

`_invoke` (via `invokeNode`) may mutate `runState` (push to `trace`, increment counters), call the tracer and logger, recursively invoke sub-nodes, and read/write the `local` and `ctx` references passed in. The `ctx` parameter is intentionally mutable — the library does not copy it at the boundary (§2.2 "Mutation model"). The one exception is `parallel`, which shallow-copies per branch (§8).

### 2.2 Plumbing: `invokeNode`

The library provides one shared framing helper used by atomic and group builders:

```js
async function invokeNode(doInvoke, kind, entry, ctx, local, runState, path) {
  // 1. Increment cycle counter on the live local first — the
  //    snapshot below will then reflect the post-increment value.
  local._cycles = (local._cycles ?? 0) + 1;

  // 2. Build the TraceEntry with snapshots of ctx and local.
  //    local._cycles is already incremented, so entryRec.cycle
  //    and entryRec.local._cycles agree.
  const entryRec = {
    path,
    kind,
    cycle: local._cycles,
    entry,
    ctx:   { ...ctx },             // shallow snapshot
    local: { ...local },           // shallow snapshot (includes _cycles)
    startTime: Date.now(),
    // endTime and exit are filled in on successful completion;
    // on a library throw, the entry remains in the trace with
    // endTime/exit undefined — it marks where the run died.
  };

  // 3. Push first — presence in the trace makes the call
  //    observable as a step.
  runState.trace.push(entryRec);

  // 4. Step-budget check.
  if (runState.trace.length > runState.maxSteps) {
    throw new RailRuntimeError('STEP_BUDGET_EXCEEDED', { flowName: runState.flowName });
  }

  // 5. Kill check.
  if (runState.killSignal?.aborted) {
    throw new RailRuntimeError('KILLED', { flowName: runState.flowName });
  }

  // 6. Tracer begin event (wrapped per tracerErrorPolicy).
  emitTrace(runState, entryRec, 'begin');

  // 7. Delegate. The entryRec is passed as the last argument so
  //    atomic builders can expose it via runInfo.traceEntry.
  //    If doInvoke throws, we do not catch — the run is over.
  //    The entry remains in the trace with endTime/exit unset.

  const exit = await doInvoke(entry, ctx, local, runState, path, entryRec);

  // 8. Complete the trace entry.
  entryRec.exit    = exit;
  entryRec.endTime = Date.now();
  emitTrace(runState, entryRec, 'end');
  emitLog(runState, entryRec);

  return exit;
}
```

The `kind` parameter carries the node's `__rail_kind__` so that the TraceEntry records it without requiring the caller to look it up. The `entryRec` is passed to `doInvoke` as a trailing argument so atomic-builder `doInvoke` implementations can place it on `runInfo.traceEntry`; group builders that do not call user functions can ignore it.

**Throws are run-terminal.** If `doInvoke` throws — whether a `RailError` from inside, a non-library value that `catchTo` (§11) did not catch and that propagates out of an atomic builder, or anything else — the throw propagates out of `invokeNode` unchanged. There is no catch, no further trace bookkeeping, no `'end'`-event emission. The run is over. Non-library throws are wrapped as `UNHANDLED_THROW` only at the two authoritative boundaries: `flow.run` (top-level) and `parallel` (per rejected branch). User-thrown exceptions intended as control flow must be caught by `catchTo` (§11) *inside* the user function (or via `step`/`pass`/`fail`/`r.step`-with-`catchTo`, all built on `catchTo`); an uncaught throw signals a contract violation (§2.1) and tears down the run.

This is why the TraceEntry has no `error` field: the trace records the *clean execution path*. The last entry in `runState.trace` without `endTime` marks where the run died, but the error itself is the thrown value at the `flow.run` call site.

`emitTrace` invokes the configured tracer callback with two arguments — the trace entry and the event name. The tracer signature is therefore:

```js
tracer(entry: TraceEntry, event: 'begin' | 'end')
```

Tracers receive the live TraceEntry by reference. The library mutates this entry between the `'begin'` event and the `'end'` event (setting `endTime` and `exit`). Tracers that retain entries for later use — for replay, visualisation, post-hoc analysis — must clone them at the moment of receipt. The library does not freeze entries; mutation discipline is a tracer-author concern.

`emitTrace` wraps each tracer call with a `try/catch` governed by `runState.tracerErrorPolicy` (`'swallow'` or `'throw'`). With `'swallow'` (the default), tracer exceptions are silently dropped so that buggy tracers cannot derail a run. With `'throw'`, they propagate as library errors and terminate the run like any other throw out of `_invoke`.

`emitLog` invokes the configured logger callback after the step completes successfully — once per invocation, with the completed entry. It is wrapped in a `try/catch` governed by `runState.loggerErrorPolicy` (default `'throw'`). See §13.6 for the full policy semantics. The logger is **not** invoked for steps that ended in a library throw — those steps have no `'end'` to log.

The tracer is invoked **after** the step-budget and kill checks have been passed. A step that fails the budget or kill check throws before its `'begin'` event fires; its TraceEntry remains in the trace with only `startTime` set. Every `'begin'` event has at most one matching `'end'` event — but a clean run guarantees exactly one of each, and an aborted run leaves the final `'begin'` without its `'end'`.

#### `doInvoke` signature

```js
async doInvoke(entry, ctx, local, runState, path, traceEntry) → string
```

The trailing `traceEntry` is the TraceEntry that `invokeNode` pushed for this invocation. Atomic-builder `doInvoke` uses it to construct `runInfo` (§11); group-builder `doInvoke` typically ignores it.

Each builder constructs its own `doInvoke` closure (capturing any builder-time data such as the user function, sub-nodes, or branches) and sets `_invoke` to a tiny wrapper that calls `invokeNode` with it:

```js
node._invoke = (entry, ctx, local, runState, path) =>
  invokeNode(doInvoke, kind, entry, ctx, local, runState, path);
```

The wrapper is the only invocation-related field on the node object. `doInvoke` lives as a closure variable inside the builder — not exposed on the node, not reachable via `this`.

#### Wrapper builders bypass `invokeNode`

Wrapper builders (`pin`, §4) **do not use** `invokeNode`. Their `_invoke` directly invokes the inner node's `_invoke`, performing whatever transformation they need (entry re-mapping for `pin`). They are trace-transparent per the definition in §2 above.

Callers (Group-Nodes invoking sub-nodes, or the top-level runner) invoke any node uniformly:

```js
const result = await subNode._invoke(entry, ctx, local, runState, subPath);
```

`invokeNode` is exported by the library as an **extension API**. Custom-kind authors who need the standard framing import it and follow the same wrapper-closure pattern as the built-in atomic and group builders. Wrapper-like custom kinds that want to be transparent in the trace build `_invoke` directly without using `invokeNode`.

#### Mutation model

`ctx` is passed by reference through all sequential invocations. User functions mutate it in place; mutations are visible to the next node and to subsequent steps. There is no return-channel for ctx — `_invoke` returns only the chosen exit name. Code that wants to "replace" the whole ctx does an in-place clear-and-rebuild (§11), analogous to how `local` is replaced.

The library does **not** copy ctx at the node boundary in sequential activities — copying would be wasted work in the common case and would silently hide mutations the user intended to make. `parallel` is the one exception: it shallow-copies ctx for each branch (so branches do not race on the same object), and after the branches settle it overwrites the incoming ctx in place with the aggregated `{ branchName: branchCtx, ... }` shape (§8, §15.6).

The `local` parameter is **not** copied at any boundary. It is mutable position-specific state and is shared with the parent node by reference (§2.3 below).

`runState.trace` snapshots are still taken: `entryRec.ctx = { ...ctx }` and `entryRec.local = { ...local }` are shallow snapshots at push time. Trace consumers see the values at the moment of entry, not later mutations.

### 2.3 Hierarchical local state

Local state is **not** kept in a global map. Each Group-Node (Activity, Parallel) is responsible for storing the local of each of its children alongside its own local. The structure used internally is the Group-Node's choice — the spec only requires:

- Before each sub-invocation, the parent reads its stored local for the sub-position (or creates a fresh `{}` if none) and passes it as the `local` parameter.
- After the sub-invocation returns, the parent's storage already reflects any mutations the child made on the reference. No re-store step is needed.

The natural pattern (used by the reference implementation): the parent keeps `local.children` as a plain object keyed by sub-name for Activity, `local.branches` keyed by branch name for Parallel, and (if a merge node is configured) `local._merge` for Parallel's merge step. Cycle counters live in the hierarchical storage too — as the field `local._cycles` on each position's slot, incremented by `invokeNode` (§2.2).

Two important consequences:

- The same node instance added under two different local names in the same outer Activity (e.g. `first` and `second`) has two independent locals, because the parent allocates them under distinct keys in `local.children`.
- Two pins of the same Multi-Entry Activity have independent locals for the same reason: each pin appears under its own registered name in the parent, so the parent stores their locals in separate slots.

### 2.4 Mermaid render

There are two entry points for Mermaid output:

- **`flow.toMermaid(opts?)`** — convenient when you have a flow; uses the flow's top-level name as the label.
- **`activity.toMermaid(name?, opts?)`** — directly on an Activity. The `name` argument labels the rendered activity; if omitted, the diagram uses `'<anonymous>'`.

Both produce a `flowchart LR` string with the same conventions:

- Each entry rendered as `start_<entry-name>(["entry-name"])`. Activities with multiple entries produce one such start node per entry, each connected to whatever the corresponding entry wires to.
- Each sub-node rendered as a rectangle: `nodeId["node-name"]`.
- Sub-activity nodes rendered as a `subgraph` block (Mermaid's `subgraph subId ["name"] ... end`), with the sub-activity's own nodes and wires nested inside. The library recursively expands sub-activities to whatever depth they nest. A sub-activity used at multiple positions (DAG-sharing) appears in the diagram once per position, each with its own local name — the renderer follows the graph topology, not the node-identity memoisation used by validation (§5.6).
- Parallel-Nodes rendered as a `subgraph` labelled `"parallel"` containing one nested subgraph per branch. If the parallel has a merge node, it is rendered as a second box inside the same `"parallel"` subgraph, downstream of the branches: an implicit edge from each branch's exit point converges on the merge's input, and the merge's outputs become the parallel's outputs. The composite reads visually as "fan-out, then merge".
- Each exit rendered as `endExit_name(["exit-name"])` with class `exit`. The library does not privilege any specific exit name; a renderer that wants distinct styling per exit can add classes afterwards based on the activity's `outputs`.
- Each wire becomes an edge labeled with the source's output port name in quoted form (`a -- "port" --> b`), or unlabeled for the entry wire.

Labels inside the quotes follow the escaping rule below.

#### Rendering non-Activity Top-Level Nodes

When a flow holds an atomic node, a Parallel-Node, or a pinned node as its top-level, `flow.toMermaid()` produces a minimal diagram:

- A synthetic entry `start(["<input>"])` labelled with the held node's single input name. (`flow(...)` enforces single-input via `MULTI_INPUT_NODE`, so there is always exactly one.) When the held node is a pin, the label is the pin's fixed entry name, not `'in'` — the pin's effective entry is visible directly in the diagram.
- The held node rendered with its standard shape. A pin is not drawn as a separate shape; the pinned inner node is rendered in the same shape it would otherwise use as a sub-node. If the inner is a Multi-Entry Activity, the diagram still shows only **the topology reachable from the pinned entry** — not all the entries the activity would expose if rendered stand-alone.
- One synthetic exit per declared output, named `endExit_<output>(["<output>"])` with class `exit`.
- A solid edge from the entry to the node, and one labelled edge per output to its corresponding exit (output names rendered in quoted form).

This makes top-level atomic and Parallel-Nodes visually inspectable without wrapping them in an Activity.

There are no implicit edges from exception mechanics: the library has no implicit throws-mapping (§2.1). Steps that convert caught exceptions into outputs do so explicitly inside their own `try`/`catch` (or via `catchTo`, §11, which wraps the user function). Those outputs are rendered as ordinary solid edges, like any other.

**Label escaping.** All user-supplied strings rendered as labels in the diagram — sub-node names, port names, entry/exit names, parallel branch keys, and the top-level flow name — are emitted inside double-quoted Mermaid labels (`"..."`) with the following HTML-entity escapes applied to each character:

| Character                                                                                       | Escape    |
|-------------------------------------------------------------------------------------------------|-----------|
| `&`                                                                                             | `&amp;`   |
| `<`                                                                                             | `&lt;`    |
| `>`                                                                                             | `&gt;`    |
| `"`                                                                                             | `&quot;`  |
| `\|`                                                                                            | `&vert;`  |
| Newline (`\n`, `\r`), tab (`\t`), and other ASCII control characters (U+0000 to U+001F except space) | each replaced with a single space |

All other characters — including `(`, `)`, `[`, `]`, `{`, `}`, `#`, `/`, backslash, and any Unicode beyond ASCII — are passed through unchanged. Mermaid's parser handles them correctly inside quoted labels.

The reserved character `.` (§5.1) cannot appear in user-supplied names by construction, so it never reaches the renderer.

This rule applies uniformly to both node labels and edge labels. The renderer always uses the quoted form for both, even when the label would be unambiguous without quotes, so that the escaping rule has a single consistent application point.

**Why escape rather than restrict.** The reserved-character list in §5.1 (just `.`) is minimal and semantically grounded in the library's own conventions — `.` carries internal meaning in wire references. Mermaid's special characters carry no such meaning in the rail.js graph itself; they only cause trouble at render time. Restricting them in names would couple the naming rules to a specific renderer, which is the wrong layer.

Options accepted by `toMermaid()`:

- `direction?: 'LR' | 'TB'` — flowchart direction. Default `'LR'`.

---

## 3. Atomic Nodes

`atom` is the library's single atomic-node primitive. `nstep` is a convenience layer on top of `atom` that accepts string-or-array inputs/outputs and lets the user function return a nullish value (`undefined` or `null`) when there is only one possible output. `step`, `pass`, and `fail` are factory functions that wrap the user function with `catchTo` (§11) and pass the result to `nstep` — they produce ordinary `nstep`-built atoms with a single-exit catching convention applied to the user function. All five builders return atoms (`__rail_kind__: 'atom'`); there is no separate catching kind.

| Builder           | `__rail_kind__` | Inputs          | Outputs                  | fn signature                            | Normal return        | Non-library exception          |
|-------------------|-----------------|-----------------|--------------------------|------------------------------------------|----------------------|--------------------------------|
| `atom(fn, opts)`  | `'atom'`        | declared in `opts` | declared in `opts`    | `(ctx, local, runInfo) → string`        | → `exit` from return | propagates (rule violation)    |
| `nstep(fn, in, out)` | `'atom'`     | as given        | as given                 | `(ctx, local, runInfo) → string \| undefined \| null` | → returned exit; if nullish and single-output, → that output | propagates (rule violation) |
| `step(fn)`        | `'atom'`        | `['success']`   | `['success', 'failure']` | `(ctx, local, runInfo) → void`          | → `success`          | → `failure` (`ctx._error = e`) |
| `pass(fn)`        | `'atom'`        | `['success']`   | `['success']`            | `(ctx, local, runInfo) → void`          | → `success`          | → `success` (`ctx._error = e`) |
| `fail(fn)`        | `'atom'`        | `['failure']`   | `['failure']`            | `(ctx, local, runInfo) → void`          | → `failure`          | → `failure` (`ctx._error = e`) |

User functions mutate the incoming ctx in place. `atom`'s function returns the exit name as a string. `nstep`'s function returns either an output name as a string or a nullish value (`undefined` or `null`); nullish is accepted only when the atom has a single output, in which case the underlying atom uses that output. With multiple outputs, a nullish return is invalid and surfaces as `UNKNOWN_OUTPUT_AT_RUNTIME` (§12.1). `step`/`pass`/`fail`'s functions are documented as `void` because their `catchTo`-wrapper folds whatever the user function returns into a fixed exit. The five builders form a hierarchy: `atom` is the primitive, `nstep` is a convenience layer, `step`/`pass`/`fail` are `nstep`-based specialisations with their user function wrapped by `catchTo` (§11) to route non-library exceptions to a fixed exit with `ctx._error` set.

`RailError` and `RailAggregateError` are never caught by `catchTo` (§11) — they always propagate, terminating the run.

The shared user-function contract is defined in §11 and not restated per-builder.

### 3.1 `atom(fn, options)`

The generic atomic builder. The user function chooses its exit by returning the exit name; mutations to ctx are made in place.

```js
import { atom } from './rail.js';

const send = atom(sendFn, {
  inputs:  ['in'],            // optional, default ['in']
  outputs: ['ok', 'net5xx', 'net4xx'],
});

async function sendFn(ctx, local, runInfo) {
  try {
    const response = await fetch(ctx.url, { body: ctx.body, signal: runInfo.signal });
    ctx.status = response.status;
    return 'ok';
  } catch (e) {
    ctx._error = e;
    if (e.name === 'NetworkError') return 'net5xx';
    return 'net4xx';
  }
}
```

- `__rail_kind__: 'atom'`
- **Function signature:** `async fn(ctx, local, runInfo) → string` — must return one of `node.outputs`.

**Builder validation.**

- `fn` must be a function.
- `options` is a plain object.
- `options.outputs` is required: a non-empty array of unique names (§5.1).
- `options.inputs` is optional: a non-empty array of unique names (§5.1). Defaults to `['in']`.

### 3.2 `nstep(fn, inputs, outputs)`

Convenience constructor on top of `atom`. Two conveniences over the raw `atom`:

1. **String-or-array inputs and outputs.** Single names may be passed as plain strings rather than one-element arrays.
2. **Single-output nullish-return.** If `outputs` is a single name, the user function may return `undefined` (i.e. no explicit return) or `null`; the atom uses the fixed output name. The user function may **also** return the output name explicitly — all three forms are accepted. Returning any other value with a single output raises `RailRuntimeError(UNKNOWN_OUTPUT_AT_RUNTIME)`, same as `atom`.

```js
import { nstep } from './rail.js';

// Single-output: user function may simply return without value
const audit = nstep(async (ctx) => {
  await fakeLog(ctx);
}, 'success', 'success');

// Single-output: explicit return is equally valid
const auditExplicit = nstep(async (ctx) => {
  await fakeLog(ctx);
  return 'success';
}, 'success', 'success');

// Multi-output: user function returns the exit string
const lookup = nstep(async (ctx, local, runInfo) => {
  const result = await fetchUser(ctx.id, { signal: runInfo.signal });
  if (!result) return 'retry';
  ctx.user = result;
  return 'main';
}, 'main', ['main', 'retry', 'fail']);
```

**Definition.**

```js
function nstep(fn, inputs, outputs) {
  const inputList  = Array.isArray(inputs)  ? inputs  : [inputs];
  const outputList = Array.isArray(outputs) ? outputs : [outputs];

  const wrappedFn = async (ctx, local, runInfo) => {
    const ret = await fn(ctx, local, runInfo);
    if (ret == null && outputList.length === 1) {
      return outputList[0];
    }
    return ret;     // atom validates against outputList
  };

  return atom(wrappedFn, { inputs: inputList, outputs: outputList });
}
```

- `__rail_kind__: 'atom'` — `nstep` is not a distinct kind; it is a convenience over `atom`.
- **Function signature:** `async fn(ctx, local, runInfo) → string | undefined | null`. The string, when returned, must be one of the declared outputs (validated by the underlying `atom`). `undefined` and `null` are accepted only when `outputs` is a single name; the atom then uses that output. A multi-output `nstep` whose user function returns `undefined`/`null` raises `RailRuntimeError(UNKNOWN_OUTPUT_AT_RUNTIME)` at the underlying `atom` level — the message lists the valid outputs.

**Builder validation.**

- `fn` must be a function.
- `inputs` and `outputs` are each either a non-empty string (single name) or a non-empty array of unique names (§5.1).

**Convention: input names match rail names.** When `nstep` is used in conjunction with `nrail` (§6), input endpoints are typically named after the rails the step consumes. This makes the topology readable: a step on rail `success` has input endpoint `name.success`, not `name.in`. The `catchTo`-wrapped specialisations `step`/`pass`/`fail` follow this convention.

### 3.3 `step(fn)`

The convenience factory for the Railway pattern: one input named `'success'`, two outputs (`'success'`, `'failure'`). The user function mutates `ctx` in place; non-library exceptions are caught and routed to `'failure'` with `ctx._error` set.

- **Function signature:** `async fn(ctx, local, runInfo) → void`

**Definition.**

```js
function step(fn) {
  const inner = async (ctx, local, runInfo) => {
    await fn(ctx, local, runInfo);
    return 'success';
  };
  return nstep(catchTo(inner, 'failure'), 'success', ['success', 'failure']);
}
```

The inner wrapper turns `fn`'s `undefined` return into `'success'`. `catchTo` (§11) catches any non-library exception, places it on `ctx._error`, and returns `'failure'` instead. `nstep` then builds an atom with input `'success'`, outputs `['success', 'failure']`, and the wrapped function. On normal return → `'success'`; on caught throw → `'failure'` with `ctx._error` set. `__rail_kind__: 'atom'`.

### 3.4 `pass(fn)`

A "this side of the rails" node: one input named `'success'`, one output (`'success'`). Both normal returns and caught exceptions route to `'success'`; on caught exception, `ctx._error` is set.

- **Function signature:** `async fn(ctx, local, runInfo) → void`

**Definition.**

```js
function pass(fn) {
  const inner = async (ctx, local, runInfo) => {
    await fn(ctx, local, runInfo);
    return 'success';
  };
  return nstep(catchTo(inner, 'success'), 'success', 'success');
}
```

The inner wrapper awaits `fn`, discards its return value, and returns `'success'` explicitly. `catchTo` (§11) only intervenes on throw, routing to `'success'` with `ctx._error` set (overwrite semantics — see §10.2). `__rail_kind__: 'atom'`.

### 3.5 `fail(fn)`

The mirror of `pass` on the failure rail: one input named `'failure'`, one output (`'failure'`).

- **Function signature:** identical to `pass`.

**Definition.**

```js
function fail(fn) {
  const inner = async (ctx, local, runInfo) => {
    await fn(ctx, local, runInfo);
    return 'failure';
  };
  return nstep(catchTo(inner, 'failure'), 'failure', 'failure');
}
```

The inner wrapper awaits `fn`, discards its return value, and returns `'failure'` explicitly. On throw, `catchTo` sets `ctx._error` (overwrite semantics — see §10.2) and routes to `'failure'`. `__rail_kind__: 'atom'`.

**Builder validation for `step`, `pass`, `fail`.** Each is a thin wrapper around `nstep` (§3.2) with fixed inputs and outputs; the only argument is `fn`, which must be a function. The inputs and outputs are not configurable. No further validation is needed at builder end.

### 3.6 Choosing between the five

- Use **`atom`** for code that natively returns its outcome (no exceptions for control flow). The user function chooses the exit explicitly; the library rule of §2.1 applies unmodified.
- Use **`nstep`** when you want the convenience layer (string-or-array inputs/outputs, single-output nullish-return) but no automatic catching. Throws propagate as `atom` does and terminate the run. Typical use: as the step constructor in `nrail` activities, or in `activity` for multi-rail atomics.
- Use **`step`** when interfacing with code whose native failure idiom is throwing exceptions (`fetch`, `JSON.parse`, third-party libraries), and binary success/failure routing suffices.
- Use **`pass`** when interfacing with throwing code on the success-track where any thrown exception is intentionally irrelevant to control flow (best-effort logging, metrics, notifications).
- Use **`fail`** for the symmetric case on the failure-track (error reporting, rollbacks, dead-letter handling).

**Note on input names.** `step` and `pass` have input `'success'`; `fail` has input `'failure'`. They do not use the conventional `'in'` name. The endpoint name carries the rail identity: `step`/`pass` consume the `success` rail, `fail` consumes the `failure` rail. This makes them composable with `nrail` and `railway` (where rails are addressed by name) but is a small adjustment when using them as sub-nodes in plain `activity(...)`: wire to `name.success` or `name.failure`, not `name.in`. For example: `a.wire('.entry', 'validate.success')` if `validate` is a `step`.

### 3.7 Reusing nodes

Node values produced by any builder are context-free — they hold no name and no graph position. The same node value can be added under different local names in one or more activities; each addition produces an independent position with its own local state. Validation of a builder-produced node happens once, in the builder that produced it; the outer activity's whole-graph walk visits the shared instance once via identity-memoisation (§5.6).

```js
import { step, activity } from './rail.js';

const validateNode = step(validateFn);

const wf = activity((a) => {
  a.entry('in');
  a.addNode('first',  validateNode);
  a.addNode('second', validateNode);   // same node, different position
  a.exit('success');
  a.exit('failure');
  // ... wires ...
});
```

When the outer activity is built, its internal whole-graph walk (§5.6) sees `validateNode` once: the second encounter via the identity-memoised walk is skipped. At run time, the two positions are otherwise independent: each has its own `local.children[name]` slot and produces its own trace entries.

---

## 4. Wrapper Nodes

Wrapper builders produce nodes that contain exactly **one** inner node, with the wrapper adding fixed behaviour around the inner call. They share two conventions:

- The inner node is exposed as the library-internal property `_inner`.
- They are **trace-transparent** (§2). The inner node's invocation is the only one visible in the trace.

The library has exactly one built-in wrapper: `pin` (§4.1). External authors may build their own wrappers — anything that exposes a node value with `__rail_type__: 'node'`, the wrapper-specific `__rail_kind__`, and a delegating `_invoke` works. Generic tooling (debug inspectors, diagram renderers, lints) walks `node._inner` recursively until it reaches a non-wrapper kind, regardless of which specific wrapper kinds appear in the chain.

**Note on exception handling.** Earlier drafts included a `catching(node, mapping, defaultOutput?)` wrapper that caught exceptions thrown by the inner node and routed them to declared outputs. This wrapper was removed: exceptions used as control flow belong inside the flow graph, not as cross-cutting jumps through node layers. Per §2.1, atomic-node user functions must not throw — for opt-in throw-to-exit routing on a single user function, use `catchTo` (§11). Throws that escape into the runtime always terminate the run.

Any state a particular wrapper needs (a pinned entry name, etc.) is implementation detail of that kind. The spec does not prescribe how it is stored. Wrappers and other custom kinds that want non-default rendering expose a `toMermaid(name?, opts?)` hook on their nodes for the diagram renderer (§15.8). This hook is outside the Node contract — generic tooling tests for its presence with `typeof node.toMermaid === 'function'` and falls back to default rendering otherwise.

### 4.1 `pin(node, entry)`

`pin` fixes the entry of a multi-input node. The resulting node has a single input (`'in'`) and the same outputs as the inner node; activating it invokes the inner node at the chosen entry.

```js
import { pin, activity } from './rail.js';

const multi = activity((a) => {
  a.entry('fromCache', 'fromAPI');
  a.exit('done');
  // ...
});

const cacheView = pin(multi, 'fromCache');
const apiView   = pin(multi, 'fromAPI');
```

Pinning is required wherever only single-input nodes are accepted: as the top-level node of a flow (§9, `MULTI_INPUT_NODE`), and as a branch of a Parallel node (§8, `MULTI_INPUT_NODE`).

**Properties of the resulting node:**

- `__rail_kind__: 'pin'`
- `inputs: ['in']`
- `outputs`: the inner node's outputs.
- `_inner`: the inner node.

There is no output filtering. To expose only a subset of the inner node's outputs, wrap it in an Activity whose exits cover the desired subset.

**Note on `local` storage.** `pin` is trace-transparent and allocates no `local` slot of its own — it passes the `local` it receives from its parent straight through to the inner node (§2.3). Two pins of the same inner node, registered under different names in the same parent, therefore have **independent locals**: each pin appears under its own registered name in the parent, so the parent stores their locals (and the inner node's view through those pins) in separate slots.

**Build-time validation.**

| Code                        | When                                  |
|-----------------------------|---------------------------------------|
| `NOT_A_NODE`                | `node` is not a Rail-Node.            |
| `UNRESOLVED_WIRE_REFERENCE` | `entry` is not in `node.inputs`.      |

---

## 5. Activity

The Activity is a graph-based group node: it contains sub-nodes and the wires that route ctx between them.

```js
import { activity, step } from './rail.js';

const myActivity = activity((a) => {
  a.entry('success');
  a.addNode('validate', step(validateFn));
  a.addNode('send',     step(sendFn));
  a.exit('ok');
  a.exit('error');

  a.wire('.success',         'validate.success');
  a.wire('validate.success', 'send.success');
  a.wire('send.success',     '.ok');
  a.wire('validate.failure', '.error');
  a.wire('send.failure',     '.error');
});
```

The builder function is invoked synchronously with an Activity builder object `a`. It declares entries and exits, adds sub-nodes, and wires them together. After the builder returns, the activity is **sealed** — no further mutation is possible.

The builder must return `undefined` (or, equivalently, no value). If `builder(a)` returns any other value — including a Promise from an async function — the library raises `RailBuildError(ASYNC_BUILDER)`. This catches the common case of accidentally writing `activity(async (a) => { ... })`: builder methods inside the async function execute as the synchronous prefix runs, but anything after an `await` runs after the activity has already been sealed, producing confusing `SEALED` errors at non-obvious points. The eager return-value check produces a single clear error at the `activity(...)` call site instead. The same rule applies to the `nrail(...)` and `railway(...)` builder closures (§6.3, §7).

**Properties of the resulting node:**

- `__rail_kind__: 'activity'`
- `inputs`: the set of declared entries (in declaration order).
- `outputs`: the set of declared exits (in declaration order).
- `_invoke`: wraps `doInvoke` via `invokeNode` (§2.2).
- `toMermaid(name?, opts?)`: see §2.4.

There is no name parameter on `activity(...)`. Names belong to use sites: the `flow(...)` factory for top-level execution, or `a.addNode(name, ...)` for sub-activity placement.

### 5.1 Name restrictions

Every user-supplied name in the library — sub-node local names assigned via `a.addNode(name, ...)`, port names declared in atomic builders' `inputs` and `outputs`, entry names from `a.entry(...)`, exit names from `a.exit(...)`, branch keys in `parallel(...)`, step names in `railway`'s `r.step` / `r.pass` / `r.fail`, and the top-level flow name passed to `flow(name, ...)` — must satisfy the following rules:

- Must be a **non-empty string**.
- Must not consist only of whitespace.
- Must not contain the reserved character **`.`**.

The single reserved character is used in **wire references** (§5.2) — the syntax `'nodeName.portName'`, where the dot separates the node-name component from the port-name component. Allowing `.` in names would make this notation ambiguous.

The **empty string** is reserved as a special node name in wire references: it refers to the activity itself (`'.in'` = the activity's entry `in`). User code cannot use the empty name for a sub-node — `a.addNode('', ...)` raises `INVALID_NAME`.

The string `'__merge__'` is reserved as the path marker for `parallel(branches, merge)`'s merge node (§8) and cannot be used as a branch name in `parallel(...)`. It remains a valid name in other contexts (sub-node names, atomic ports, activity entries/exits) — the reservation is scoped to parallel branch keys.

All other characters are accepted in user names, including `:`, `[`, `]`, `>`, `<`, `/`, and any Unicode beyond ASCII. Mermaid labels escape characters that would conflict with Mermaid syntax (§2.4) so even names with HTML special characters render correctly.

Violations raise `RailBuildError(INVALID_NAME)` per the eager-validation rule (§1.5).

### 5.2 Wire references and endpoints

Wires are declared by string references of the form `'nodeName.portName'`. The empty `nodeName` (`''`) refers to the activity itself — it is the natural "this" for the enclosing container:

| String              | Meaning                                                  |
|---------------------|----------------------------------------------------------|
| `'.in'`             | The activity's own entry named `in`                      |
| `'.ok'`             | The activity's own exit named `ok`                       |
| `'validate.in'`     | Sub-node `validate`'s input named `in`                   |
| `'validate.success'`| Sub-node `validate`'s output named `success`             |

The dot is **always required** — there is no plain `'name'` form. This keeps the parser trivial and the notation symmetric: every endpoint is `node.port`, the empty-named node being the activity itself.

**Wire direction.** `a.wire(source, target)` — ctx flows from `source` to `target`. The first argument is **always** a source, the second **always** a target — position determines whether a reference is read as a source or a target. This resolves any ambiguity at the name level: even if an activity declared both an entry `validate` and a sub-node `validate`, the position would disambiguate.

The activity's entries and exits are **inverted** with respect to the internal wire topology: an entry is a wire source (data flows out of the activity-level input into the inside), and an exit is a wire target (data flows from the inside into the activity-level output).

| Position                | External role        | Wire role |
|-------------------------|----------------------|-----------|
| Activity entry          | input                | source    |
| Activity exit           | output               | target    |
| Sub-node input          | input                | target    |
| Sub-node output         | output               | source    |

Validation at the time of the `a.wire(...)` call:

- `source` must resolve to an activity entry (`''.portName` where `portName` is a declared entry) or to a sub-node output (`subName.portName` where `portName` is a declared output of `subName`).
- `target` must resolve to an activity exit or a sub-node input under the same rules.

Misuse raises `RailBuildError(WIRE_DIRECTION_INVALID)` or `RailBuildError(UNRESOLVED_WIRE_REFERENCE)` depending on the cause.

**The same string can refer to two distinct endpoints depending on position.** A reference like `validate.success` resolves to `validate`'s output port `success` when used as the `source` argument and to `validate`'s input port `success` when used as the `target` argument — the disambiguation is positional, not syntactic. `a.wire('.success', 'validate.success')` wires the activity's `success` entry into `validate`'s `success` input; `a.wire('validate.success', 'send.success')` wires `validate`'s `success` output into `send`'s `success` input. Read each reference in the role given by its argument position.

**Endpoints (internal).** The library represents resolved wire endpoints as small plain objects used internally during the graph walk:

- `__rail_type__: 'endpoint'`
- `__rail_kind__: 'entry' | 'exit' | 'in' | 'out'`
- additional fields for navigation (the owning node, the port name, the local name in the parent activity, etc. — details are implementation-internal).

These endpoint objects are not exposed in user code; the user-facing API consists of strings only. The markers exist so that internal traversal code can dispatch on endpoint kind without resorting to `instanceof` or duck-typing.

### 5.3 Builder API

The Activity builder maintains, internally and incrementally, the activity's data structures: a node registry (name → node), an entry/exit registry, a wire index keyed by source endpoint (§15.1), and a set of already-wired output ports. Each builder method consults and updates these structures, raising `RailBuildError` per the eager-validation rule (§1.5).

- **`a.entry(...names)`** — declares one or more entries of this activity. Each name appears in the activity's `inputs`, in the order given. Returns nothing. Multiple calls and multiple names within one call are both supported (`a.entry('a'); a.entry('b')` is equivalent to `a.entry('a', 'b')`). All names across all calls must be distinct. Violations: `INVALID_NAME`, `DUPLICATE_INPUT`.

- **`a.exit(...names)`** — declares one or more exits. Each name appears in the activity's `outputs`, in the order given. Returns nothing. Same multi-call/multi-arg rules as `a.entry`. Violations: `INVALID_NAME`, `DUPLICATE_OUTPUT`.

- **`a.addNode(localName, node)`** — registers a sub-node at the given local position. Returns nothing. - `localName` must satisfy the name rules (§5.1) and must not already be in use; otherwise `INVALID_NAME` or `DUPLICATE_NODE_NAME`. - `node` must satisfy `isRailNode(...)`; otherwise `NOT_A_NODE`.

The same node value may be added under multiple names, in the same activity or in different activities. Each addition produces a separate position with its own local state; they share the same node instance — validation runs only once in the builder that produced it (§3.7).

- **`a.wire(sourceString, targetString)`** — declares a wire from the resolved source endpoint to the resolved target endpoint. Returns nothing. Structural-check violations raise `RailBuildError` (§1.5): - `UNRESOLVED_WIRE_REFERENCE` — either string fails to resolve to a known endpoint (unknown sub-node name, unknown port name, unknown entry/exit on `'.x'`). - `WIRE_DIRECTION_INVALID` — source is not usable as a source, or target is not usable as a target (per the direction table above). - `MULTIPLE_OUTGOING_WIRES` — the source endpoint already has an outgoing wire. Each output port (and each activity entry) may have at most one outgoing wire. The dual is **not** an error: multiple incoming wires to the same target endpoint are allowed and are called **convergence**.

**Declaration order.** `a.wire(...)` resolves its endpoints eagerly at the call site (§1.5). Both the source's and the target's sub-node must already be registered via `a.addNode(...)` (and any referenced activity entry/exit must already be declared via `a.entry(...)`/`a.exit(...)`); otherwise `UNRESOLVED_WIRE_REFERENCE` fires at the wire call. This means: declare entries/exits and add nodes before wiring them. There is no forward-reference mechanism in the `activity(...)` builder — that role is served by `nrail` (§6) via labels and links, where forward and backward jumps between rails are the structural pattern. In a plain `activity(...)`, topology is free, and a declare-before-wire discipline keeps stack traces at the offending line.

There are no separate `a.atom(...)`, `a.step(...)`, `a.activity(...)`, or `a.parallel(...)` builder methods. Construction (the builders) and placement (`addNode`) are kept distinct.

### 5.4 Activity API (post-builder)

After the `activity(...)` call returns, the Activity object exposes:

```js
{
  __rail_type__: 'node',
  __rail_kind__: 'activity',
  inputs:      string[],          // entry names in declaration order
  outputs:     string[],          // exit names in declaration order
  _invoke(entry, ctx, local, runState, path):
                                  // see §2.1 and §2.2
  toMermaid(name?, opts?): string,
}
```

The `outputs` array contains the activity's exit names. From inside the builder these are called *exits* (declared via `a.exit(...)`); on the Node interface they appear as `outputs`, identical to any other node kind. There is no separate `exits` field.

The `inputs` array contains the activity's entry names. At invoke time, the `entry` argument of `_invoke` selects which entry-endpoint to follow internally. If `entry` does not match any declared entry, the activity raises `RailRuntimeError(INTERNAL)` — defensive only; a wire to a non-existent input port is rejected at wire-time (`UNRESOLVED_WIRE_REFERENCE`, §5.3), and a pin with an unknown entry is rejected at pin-construction (§4.1).

An Activity does **not** have `.run()`. Top-level execution goes through a flow (§9).

The activity is sealed after the builder closure returns; there is no API to add or remove nodes after construction. The builder's whole-graph validation walk runs before the activity is returned (§5.6), so any activity value handed back from `activity(builder)` is ready to use.

**Sealing is operational.** After the builder closure returns, the builder object `a` is rendered inert: any subsequent call to `a.entry(...)`, `a.exit(...)`, `a.addNode(...)`, or `a.wire(...)` raises `RailBuildError(SEALED)`. This guards against a caller that captured the builder reference (e.g. via closure) and tried to mutate the activity after the fact. The same rule applies to the `r` argument of `nrail(...)` and `railway(...)` builders.

The internal graph-walk algorithm is sketched in §15.7.

### 5.5 Sub-activities and identity-based DAG-sharing

#### 5.5.1 Declaration

A sub-activity is any activity added as a node to another activity. `rail` does not distinguish "top-level" and "sub" by construction — the distinction is positional: an activity is top-level when passed to `flow(name, node)`, sub when used inside another activity.

```js
import { activity, step, flow } from './rail.js';

const innerActivity = activity((a) => {
  a.entry('success');
  a.addNode('work', step(workFn));
  a.exit('done');
  a.wire('.success', 'work.success');
  a.wire('work.success', '.done');
  a.wire('work.failure', '.done');
});

const outerActivity = activity((a) => {
  a.entry('success');
  a.addNode('child', innerActivity);          // sub-activity
  a.exit('done');
  a.wire('.success',    'child.success');
  a.wire('child.done',  '.done');
});

const f = flow('outer', outerActivity);
const r = await f.run(ctx);
```

#### 5.5.2 Validation behaviour

The whole-graph walk performed by a group builder at the end of its construction (§5.6) traverses sub-nodes by identity. If the same node instance is used in multiple positions in the assembled sub-graph, the walk visits it once: the second encounter is skipped. This memoises shared utility nodes so the cost of validation is linear in the number of distinct node instances, not in the number of positions they occupy.

#### 5.5.3 Runtime behaviour

A sub-activity invoked as a node behaves like any other group node: it enters via the activated entry, runs its internal graph to one of its exits, and returns through the corresponding exit name. Local state is hierarchical (§2.3): `local.children[subName]` is the sub-activity's own local object, owned by its parent and persisting across multiple activations within the same run (so retries and convergence accumulate). A new `flow.run(...)` starts with a fresh empty top-level `local`, so all sub-locals start empty too.

The path-array (§9) is extended with the sub-activity's local name on the way in. The Mermaid renderer (§2.4) renders sub-activities as nested subgraphs.

#### 5.5.4 Naming inside parallel branches

Inside `parallel(...)` (§8), each branch is itself a Node — most commonly an activity. A node `work` inside branch `branchA` of a parallel added as `par` inside the Flow's held activity has path `['par', 'branchA', 'work']` (the Flow's name itself is not part of `path`, §2.1).

#### 5.5.5 Self-reference is impossible by construction

Activities are sealed after the builder closure returns; references in the parent activity capture the inner activity at `addNode` time. An activity cannot embed itself — a self-reference is impossible because the inner reference must exist *before* the outer's builder closure runs.

The same inner activity may be embedded multiple times in the same outer (or across different outers) — that is allowed and produces independent positions with independent `local` slots (§2.3). What the library rules out is **runtime recursion through a graph cycle**: there is no construct that lets the graph re-enter the activity currently executing. Wires plus sub-activity embedding form a static DAG of constructions (the topology never changes after sealing), even though execution can revisit positions via cycle wires (§5.6).

### 5.6 Validation rules

Eager checks during the `activity(builder)` closure raise `RailBuildError` immediately:

- Names follow §5.1; invalid names raise `INVALID_NAME`. Duplicates within each of the three separate namespaces raise distinct codes: entry names within `a.entry(...)` raise `DUPLICATE_INPUT`, exit names within `a.exit(...)` raise `DUPLICATE_OUTPUT`, and sub-node names within `a.addNode(...)` raise `DUPLICATE_NODE_NAME`. An entry name and a sub-node name (or an exit name and a sub-node name) may coincide without conflict — the namespaces are addressed differently in wire syntax (`'.entry'` vs `'node.port'`).
- `a.addNode(name, node)` requires `isRailNode(node) === true`; otherwise `NOT_A_NODE`.
- `a.wire(src, tgt)` requires `src` to resolve to a usable source and `tgt` to a usable target (§5.2, §5.3); otherwise `UNRESOLVED_WIRE_REFERENCE` or `WIRE_DIRECTION_INVALID`. A source endpoint that already has an outgoing wire raises `MULTIPLE_OUTGOING_WIRES`.

After the builder closure returns, the activity runs a whole-graph walk over its assembled sub-graph before returning. The walk checks invariants that cannot be checked piecewise:

- At least one entry and at least one exit (otherwise `MISSING_INPUTS` / `MISSING_OUTPUTS`).
- At least one sub-node (`MISSING_NODES`).
- Every entry is the source of exactly one wire.
- Every exit is the target of at least one wire (multiple incoming wires are allowed — convergence, §5.3).
- Every sub-node output is the source of exactly one wire (`UNUSED_PORT` if none).
- Every sub-node has at least one of its inputs wired (otherwise `UNREACHABLE_NODE`); multi-input nodes may leave some inputs unwired, but at least one must be reachable.

The walk follows sub-node references by identity. A node instance reachable from multiple positions in the assembled graph is visited once: the second encounter is skipped (identity-memoised walk). Self-reference is structurally impossible (§5.5.5), so the memoisation handles DAG-sharing only, not cycles.

Cycles in the wire graph are allowed (retry loops, polling, state machines) — they are a runtime concern bounded by the step budget (§13.5), not a validation issue.

---

## 6. n-Rail

`nrail(builderFn)` is a convenience factory producing a standard Activity (`__rail_kind__: 'activity'`) for pipelines with n parallel tracks ("rails"). Where `activity(...)` requires manual `a.wire(...)` calls and `railway(...)` (§7) is restricted to two fixed tracks, `nrail` automates the wiring via a build-time **Live-Set**: each declared step consumes named rails and produces named rails, and the builder maintains the open wires between them. The result is a fully ordinary Activity — `flow(...)`, sub-activity nesting, parallel branches, and `toMermaid()` all work without modification.

```js
import { nrail } from './rail.js';

const wf = nrail((r) => {
  r.entry('success');
  r.step('validate', validateFn, 'success', ['success', 'failure']);
  r.step('encrypt',  encryptFn,  'success', ['success', 'failure']);
  r.step('logError', logErrorFn, 'failure', 'failure');
});
```

The resulting Activity has:

- `__rail_kind__: 'activity'`
- `inputs`: the names from `r.entry(...)`, in declaration order
- `outputs`: the rails still in the Live-Set at build end, in order of first appearance (§6.8)

`nrail` finalises the assembled activity at the end of the build, including the activity-level whole-graph validation walk (§5.6).

### 6.1 Positioning relative to `activity` and `railway`

| Factory     | Topology                  | Wires                                       | Use case                                     |
|-------------|---------------------------|---------------------------------------------|----------------------------------------------|
| `activity`  | arbitrary                 | manual (`a.wire`)                           | irregular graphs, arbitrary backward wires   |
| `railway`   | fixed 2 rails             | fully automatic                             | Trailblazer-style success/failure            |
| `nrail`     | n rails, linear sequence  | automatic via Live-Set + explicit links + node composition | multiple parallel outcome tracks |

### 6.2 Mental model

An n-Rail Activity reads like a swimlane diagram: time runs horizontally (declaration order in the builder), rails run vertically. Each step is a vertical connection — it consumes incoming wires on some rails and produces outgoing wires on others.

### 6.3 `nrail(builderFn) → Activity`

`builderFn` is invoked synchronously with a builder object `r`. After it returns, the Activity is sealed (as with `activity(...)`). The builder must return `undefined`; an async builder or any non-`undefined` return raises `RailBuildError(ASYNC_BUILDER)` (§5).

### 6.4 `r.entry(...names)`

Declares the **entries** of the resulting Activity. Must be called **exactly once** and **before any other builder method**.

```js
r.entry('main', 'retry', 'fail');
```

Properties:

- Names follow §5.1 (no `.`, no empty string, etc.).
- At least one name required.
- Names are immediately available as entry endpoints in the Live-Set (§6.7).
- In single-entry workflows (the common case), only one name is passed.

The signature mirrors `a.entry(...names)` from `activity` (§5.3), which also accepts multiple names per call. The difference is that `r.entry(...)` in n-Rail must be called **exactly once and before all other methods** — the builder structure distinguishes clearly between "declare entries" (once, at the start) and "declare steps" (repeatedly, in order).

Build errors:

- `MISSING_INPUTS` — no name passed.
- `DUPLICATE_NODE_NAME` — name appears twice.
- `INVALID_NAME` — name violates §5.1.
- `ENTRIES_ALREADY_DECLARED` — second call to `r.entry(...)`.
- `ENTRIES_NOT_DECLARED` — another builder method called before `r.entry(...)`.

### 6.5 `r.step(name, fn, inputs, outputs)`

The convenience step-builder method. Adds a step to the Activity that consumes the given rails and produces the given rails. Equivalent to `r.addNode(name, nstep(fn, inputs, outputs))` (§6.7); see §3.2 for `nstep`'s function-signature semantics (`string | undefined | null` return, single-output convenience).

```js
r.step('validate', validateFn, 'success', ['success', 'failure']);
```

Parameters:

- `name: string` — local name of the step within the Activity (§5.1). Registered via `a.addNode(name, ...)`.
- `fn` — user function. Signature: see §3.2 (`nstep`) and §11.
- `inputs: string | string[]` — rail or rails this step consumes. Each input rail becomes an identically-named atom input endpoint (`name.<rail>`); convergence happens per rail (§6.7).
- `outputs: string | string[]` — rail or rails this step may route to. With multi-output, the user function must return the exit name (§3.2); with single-output, the exit is implicitly the only output.

Build errors:

- `DUPLICATE_NODE_NAME` — name already taken.
- `INVALID_NAME` — name violates §5.1.
- `MISSING_OUTPUTS` — `outputs` empty.
- `RAIL_NOT_LIVE` — a rail in `inputs` is not in the Live-Set. Error message lists the available rails.
- `TypeError` — `fn` is not a function (§1.5).

### 6.6 `r.label(name, rail)` and `r.link(labelName, rail)`

Labels and links provide named anchors and arbitrary jumps within the otherwise sequential structure. Together they enable retry loops, fan-in points, and forward references.

#### `r.label(name, rail)`

Declares a named anchor on `rail`. The node consumes **nothing** from the Live-Set — its input is reachable only via `r.link(...)`.

```js
r.label('checkpoint', 'main');
```

Properties:

- Consumes nothing from the Live-Set.
- Produces one Live-Set entry on `rail` (output `name.<rail>`).
- Added as a regular node to the Activity, visible in traces and Mermaid output.
- The node itself does not modify ctx (no-op function).
- The `name` is addressable as a link target.

Since the label does not consume from the Live-Set, its position in the builder is *freely chosen* — it only determines where the label's output entry lands in the Live-Set. Typical use: at the start of a loop body, so the first step of the body can receive convergent inputs from both the regular incoming path and the loop link.

Implementation: an `atom` with `inputs: ['in']`, `outputs: [rail]`, and a no-op function returning the rail name as exit string. The builder additionally maintains a label table `name → endpoint` storing the label's input endpoint for `r.link(...)` resolution.

Build errors:

- `DUPLICATE_NODE_NAME` — name already taken as a step or label.
- `INVALID_NAME` — name violates §5.1.

#### `r.link(labelName, rail)`

Creates a wire from each Live-Set entry on `rail` to the input endpoint of the named label.

```js
r.link('checkpoint', 'retry');
```

Properties:

- Consumes all Live-Set entries on `rail` (convergence if multiple are open).
- For each consumed entry, creates a wire `source → <labelName>.in`.
- Produces **no** new Live-Set entry.
- Does **not** appear as a separate node in traces or Mermaid output — it is a pure wire instruction.

The label may not yet be declared at the time `r.link(...)` is called. In that case the builder records the link as pending and resolves it when the label is later declared (forward link). Backward and forward links are treated identically.

Build errors:

- `UNKNOWN_LABEL` — pending links remain unresolved at build end. Error message lists the missing label names and the known labels.
- `RAIL_NOT_LIVE` — `rail` is not in the Live-Set when `r.link(...)` is called.

### 6.7 `r.addNode(name, node)` and the Live-Set

`r.addNode(name, node)` inserts an arbitrary rail.js node into the n-Rail Activity. The node is wired via the Live-Set mechanism — its input endpoint names are interpreted as rails to consume, its output endpoint names as rails to produce.

```js
const validateActivity = activity((a) => {
  a.entry('main');
  a.exit('main', 'fail');
  // ...
});

r.addNode('validate', validateActivity);
```

Parameters:

- `name: string` — local name within the n-Rail Activity (§5.1). Registered via `a.addNode(name, node)`.
- `node` — any rail.js node: an `atom`, an `activity` / `railway` / `nrail`, a `pin`-wrapped node, or a `parallel` node.

The builder reads `node.inputs` and `node.outputs` directly from the node and uses them for the Live-Set mechanism. There are no separate `inputs`/`outputs` arguments — endpoint names *are* the rail names.

For the wire mapping to work, the node's endpoint names must match the n-Rail rails the user wants to engage with. To use a node with foreign endpoint names (e.g. a sub-activity with outputs `success`/`failure` in an n-Rail flow with rails `main`/`fail`), wrap it with `pin(...)` (§4.1) or an adapter activity before calling `r.addNode`. n-Rail itself performs no endpoint mapping.

`r.step` is a convenience over `r.addNode`:

```js
// r.step(name, fn, inputs, outputs) is equivalent to:
r.addNode(name, nstep(fn, inputs, outputs));
```

`nstep` (§3.2) constructs an atom from a user function and rail lists; `r.addNode` registers it. Users who construct atoms directly (or compose other nodes) use `r.addNode` straight.

Build errors:

- `DUPLICATE_NODE_NAME`, `INVALID_NAME` — as for `r.step`.
- `RAIL_NOT_LIVE` — a rail in `node.inputs` is not in the Live-Set.
- `NOT_A_NODE` — `node` is not a valid rail.js node.

#### The Live-Set

At every position in the builder there is a **Live-Set list**: an ordered list of `(rail, sourceEndpoint)` pairs. Each entry represents an **open wire** on a rail, originating from the output `sourceEndpoint` and waiting for its consumer.

It is a **list**, not a set: multiple open wires on the same rail may coexist.

#### The uniform rule

Every builder operation registers a node in the resulting Activity, optionally **consumes** entries from the Live-Set by rail name, and optionally **produces** new entries into the Live-Set. The operations differ only in what they consume and produce:

| Operation                | Consumes from Live-Set                            | Produces into Live-Set                                      |
|--------------------------|---------------------------------------------------|-------------------------------------------------------------|
| `r.entry(...names)`      | nothing (initial case)                            | one entry `(name, '.<name>')` per name                      |
| `r.step(n, fn, i, o)`    | all entries on every rail in `i`                  | one entry `(rail, n.<rail>)` per rail in `o`                |
| `r.addNode(n, node)`     | all entries on every rail in `node.inputs`        | one entry `(rail, n.<rail>)` per rail in `node.outputs`     |
| `r.label(n, rail)`       | **nothing** (input reachable only via link)       | one entry `(rail, n.<rail>)`                                |
| `r.link(labelN, rail)`   | all entries on `rail`                             | nothing                                                     |

**All declared inputs must be live.** If an operation declares an input on a rail not present in the Live-Set, `RailBuildError(RAIL_NOT_LIVE)`. Steps and links must find their inputs — there is no "consume what's there, ignore the rest".

**Convergence on consumption.** When a node consumes a rail and the Live-Set holds multiple entries on that rail, **all** are removed and a separate wire is created from each to the node's identically-named input endpoint. Convergence happens **per rail** — different input rails of the same step are different atom input endpoints (`name.main`, `name.retry`), not merged.

**Build-time vs. runtime.** The Live-Set is a build-time bookkeeping construct that determines which wires exist topologically. At runtime, `_invoke` activates exactly **one** entry and follows exactly **one** wire chain through the graph (sequentially, §2.1). Multiple incoming wires at a node are convergence in the graph, not parallelism — per invocation exactly one fires.

This rule is the only mechanic needed to read and write n-Rail code; subsequent subsections detail only individual operation specifics.

#### Transition: `r.step(name, fn, inputs, outputs)`

1. **Check and consume inputs.** Let `inputList` be the input rail list. For each rail `r_in ∈ inputList`:
   - If the Live-Set contains no entry with this rail: `RailBuildError(RAIL_NOT_LIVE)`.
   - Otherwise: remove **all** entries with this rail and collect their sources, paired with the rail identity.
2. **Wire convergence per rail.** For each collected `(source, r_in)`: create wire `source → name.<r_in>`. Multiple sources on the same rail converge on the same atom input endpoint; sources of different rails land on different endpoints.
3. **Register step.** Added via `a.addNode(name, nstep(fn, inputList, outputList))` (§3.2). The atom uses `fn` directly. With single-output, the user function may return `undefined`, `null`, or the output name as a string; the underlying `atom` validates non-nullish returns against the single declared output. With multi-output, the atom passes through the exit string returned by the user function. Throws from `fn` propagate as in any atom (§3.1) and terminate the run — for throw-to-exit routing, wrap `fn` with `catchTo(fn, exitName)` (§11).
4. **Append outputs to Live-Set.** For each rail `r_out ∈ outputList`: append `(r_out, name.<r_out>)`.

#### Transition: `r.addNode(name, node)`

Identical to `r.step` with two differences:

1. **Source of inputs/outputs.** Instead of from the arguments, `inputs` and `outputs` come from the node's properties (`node.inputs`, `node.outputs`). These are already fixed on the node and are read by the builder.
2. **Node registration.** Instead of constructing a new atom via `nstep(...)`, the supplied node is registered directly via `a.addNode(name, node)`.

The Live-Set mechanics (per-rail convergence, output appending, build errors) are identical to `r.step`.

#### Transition: `r.label(name, rail)`

**Consumes nothing from the Live-Set.** The label's `in` endpoint is reachable only via `r.link(...)`.

1. **Register the label.** A node is added via `a.addNode(name, atom)` with `inputs: ['in']`, `outputs: [rail]`. The atom is a no-op function `fn = () => rail` returning the rail name as exit string (not the string literal `'rail'`); ctx is not modified.
2. **Update the label table.** The input endpoint `name.in` is registered in the builder's label table under `name` and remains there until build end — entries are not "consumed" by links. Subsequent `r.link(name, ...)` calls reference this endpoint directly.
3. **Resolve pending links.** If the pending-links list has entries for `name`: for each stored source, create a wire `source → name.in` and remove the entries from the pending list.
4. **Append output to Live-Set.** Append `(rail, name.<rail>)`.

Unlike `r.step`, the label has exactly one input endpoint named `in` (not `name.<rail>`). Reason: a step gets its input identity from the consumed rail (semantically: "which path did this invocation arrive on"); a label gets its input from links that may originate from any rail — the arriving rail identity is neither preserved at the label nor relevant.

A label may be **linked multiple times** — each `r.link(name, ...)` produces its own wire to the label's input, regardless of declaration order. Multiple wires on the same input is convergence (§5.3).

#### Transition: `r.link(labelName, rail)`

**Produces nothing into the Live-Set.** Creates one or more wires to the label's input.

1. **Check and consume inputs.** If the Live-Set has no entry on `rail`: `RailBuildError(RAIL_NOT_LIVE)`. Otherwise: remove all entries on this rail and collect their sources.
2. **Create wires or defer.**
   - If `labelName` is already in the label table: for each collected source, create a wire `source → labelName.in` immediately.
   - Otherwise (forward link): append the sources under `labelName` to the pending-links list. Resolution occurs when `r.label(labelName, ...)` is later called.

Forward and backward links are treated equally; the mechanism does not distinguish them. Multiple `r.link(labelName, ...)` calls to the same label are allowed — they accumulate either directly in the wire graph (if the label exists) or in the pending-links list (if not), and are all wired at label-resolution time.

### 6.8 Build end

When the builder returns:

1. **Check pending links.** If the pending-links list is non-empty: `RailBuildError(UNKNOWN_LABEL)` listing the unresolved label names and the known labels.
2. **Check labels for use.** For each registered label: if no incoming wire targets its `in` endpoint (no `r.link(name, ...)` ever pointed at it): `RailBuildError(UNUSED_LABEL)` listing the unused label names.
3. **Create exits.** For every distinct rail appearing in a **remaining Live-Set entry** (in order of first appearance of that rail across the builder run): declare an exit of the same name on the Activity (`a.exit(rail)`).
4. **Wire Live-Set to exits.** For each remaining Live-Set entry `(rail, source)`: create wire `source → .<rail>`. Multiple entries on the same rail produce convergence on the same exit.
5. **Run the activity's whole-graph validation walk** (§5.6).

The asymmetry between steps 1 and 2 is intentional:

- *Every link must match a label* (step 1) — otherwise links would vanish silently.
- *Every label must have at least one link* (step 2) — otherwise the label is an Activity node without incoming wire, which the whole-graph walk would flag generically. The dedicated `UNUSED_LABEL` error provides better diagnosis.

Both checks are n-Rail-specific pre-validations that catch problems with clearer language before the generic walk would report them.

Rails that appear as step output or label output during the builder run but are then fully consumed by subsequent operations are **internal routing names only** and do **not** become exits. Example: the rail `special` in §6.11 is fully consumed by `r.link('merge', 'special')`; it is not in the Live-Set at build end and therefore produces no `.special` exit. This guarantees that every created exit has at least one incoming wire — the validation invariant "every exit is the target of at least one wire" (§5.6) does not fire spuriously.

A rail declared via `r.entry(...)` but never consumed (its initial Live-Set entry remains until build end) produces an exit of the same name and a direct path `entry → exit` with no intermediate node.

### 6.9 Throw behaviour

**n-Rail steps do not catch exceptions automatically.** When a user function throws, the exception propagates as for any atom (§3.1) — the Activity aborts and the throw reaches the `flow.run` caller. This is consistent with the rest of the system: callers wanting to choose an exit per invocation return it as a string; callers signalling a bug or unrecoverable situation throw.

For throw-to-exit routing, wrap the user function with `catchTo(fn, exitName)` (§11):

```js
import { nrail, catchTo } from './rail.js';

r.step('validate', catchTo(validateFn, 'failure'), 'main', ['main', 'failure']);
r.step('lookup',   catchTo(lookupFn, 'hardfail'), 'main', ['main', 'retry', 'hardfail']);
r.step('audit',    catchTo(auditFn, 'success'),   'success', 'success');
```

Projects wanting a consistent throw-routing convention build their own helper. Example: a `stepCatch` that always routes throws to the last output (Railway-style convention):

```js
const stepCatch = (r, name, fn, inputs, outputs) => {
  const list = Array.isArray(outputs) ? outputs : [outputs];
  r.step(name, catchTo(fn, list[list.length - 1]), inputs, outputs);
};

const wf = nrail((r) => {
  r.entry('success');
  stepCatch(r, 'a',    fn1, 'success', ['success', 'failure']);
  stepCatch(r, 'pass', fn2, 'success', 'success');
  stepCatch(r, 'fail', fn3, 'failure', 'failure');
  stepCatch(r, 'step', fn4, 'success', ['success', 'failure']);
});
```

These wrappers are explicitly user code, not part of the n-Rail API. n-Rail itself has only the one `r.step` method without throw magic; each project convention is visible in its own helper function.

`RailError` and `RailAggregateError` are never caught by `catchTo` — they propagate (§2.1).

### 6.10 Validation rules

The eager checks fire immediately at the offending builder call (§1.5). n-Rail-specific build error codes:

| Code                       | Trigger                                                                                        |
|----------------------------|------------------------------------------------------------------------------------------------|
| `MISSING_INPUTS`          | `r.entry(...)` with no arguments                                                               |
| `ENTRIES_NOT_DECLARED`     | another builder method called before `r.entry(...)`                                            |
| `ENTRIES_ALREADY_DECLARED` | second call to `r.entry(...)`                                                                  |
| `RAIL_NOT_LIVE`            | input rail not in the Live-Set; message lists the available rails                              |
| `UNKNOWN_LABEL`            | pending links remain unresolved at build end; message lists the missing and the known labels   |
| `UNUSED_LABEL`             | a label has no incoming wire at build end; message lists the unused label names                |
| `DUPLICATE_NODE_NAME`           | step/label name already used                                                                   |
| `INVALID_NAME`             | name violates §5.1                                                                             |
| `MISSING_OUTPUTS`          | step declared without outputs                                                                  |
| `NOT_A_NODE`               | `r.addNode(name, node)` received a non-node                                                    |
| `MISSING_NODES`            | builder declared `r.entry(...)` but added no sub-nodes (no `r.step`/`r.addNode`/`r.label`); raised by the activity validation walk at build end |

Where a rail or label is "not found", the error message always enumerates the available alternatives.

`nrail` produces a standard Activity, so the same whole-graph validation walk that applies to `activity(...)` (§5.6) also runs at the end of an `nrail` build. The walk inherits the same set of build-error codes from §5.6. By construction, the Live-Set mechanics rule out most of those errors before the walk runs — for example, every step's output rail becomes an exit or feeds the next step, so `UNUSED_PORT` cannot fire from automatically-wired rails.

**Note on minimal Activities.** An n-Rail builder must declare at least one sub-node via `r.step` or `r.addNode`. A builder with only `r.entry(...)` (no steps, no labels) produces an Activity with no sub-nodes and is rejected by the validation walk at build end with `RailBuildError(MISSING_NODES)`, consistent with `activity(...)` and `parallel(...)`. Builders with only labels and links (no `r.step`) are similarly rejected — either by `UNUSED_LABEL`, by `UNKNOWN_LABEL`, or by the reachable-exits check.

### 6.11 Examples

#### 6.11.1 Three rails with cleanup

```js
const wf = nrail((r) => {
  r.entry('main');
  r.step('validate', validateFn, 'main', ['main', 'retry', 'fail']);
  r.step('lookup',   lookupFn,   'main', ['main', 'retry', 'fail']);
  r.step('logRetry', logRetryFn, 'retry', 'fail');
  r.step('convert',  convertFn,  'fail', 'fail');
});
```

The `retry`-rail outputs of `validate` and `lookup` both converge on `logRetry.retry` (convergence on the same atom input endpoint, since both sources produce the same rail). The `fail`-rail outputs of `validate`, `lookup`, and `logRetry` similarly converge on `convert.fail` — three wires into the same atom input. `convert.fail` then becomes the single wire to the `.fail` exit at build end.

#### 6.11.2 Retry loop via link

```js
const wf = nrail((r) => {
  r.entry('main');
  r.label('start', 'main');
  r.step('try',   tryFn,   'main', ['main', 'retry', 'fail']);
  r.step('check', checkFn, 'retry', ['retry', 'fail']);
  r.link('start', 'retry');
});
```

Walk-through. Each step lists what is consumed (removed from the Live-Set), the wires created, and what is produced (added). The Live-Set snapshot after each operation is shown in builder-declaration order.

- `r.entry('main')`
  - produces: `(main, '.main')`
  - Live-Set: `[(main, '.main')]`
- `r.label('start', 'main')`
  - consumes: nothing
  - produces: `(main, 'start.main')`
  - Live-Set: `[(main, '.main'), (main, 'start.main')]`
- `r.step('try', tryFn, 'main', ['main', 'retry', 'fail'])`
  - consumes both `(main, …)` entries via convergence: wires `'.main' → 'try.main'` and `'start.main' → 'try.main'`
  - produces: `(main, 'try.main')`, `(retry, 'try.retry')`, `(fail, 'try.fail')`
  - Live-Set: `[(main, 'try.main'), (retry, 'try.retry'), (fail, 'try.fail')]`
- `r.step('check', checkFn, 'retry', ['retry', 'fail'])`
  - consumes: `(retry, 'try.retry')`; wire `'try.retry' → 'check.retry'`
  - produces: `(retry, 'check.retry')`, `(fail, 'check.fail')`
  - Live-Set: `[(main, 'try.main'), (fail, 'try.fail'), (retry, 'check.retry'), (fail, 'check.fail')]`
- `r.link('start', 'retry')`
  - consumes: `(retry, 'check.retry')`; wire `'check.retry' → 'start.in'`
  - produces: nothing
  - Live-Set: `[(main, 'try.main'), (fail, 'try.fail'), (fail, 'check.fail')]`
- Build end: exits `main`, `fail`; wires `'try.main' → '.main'`, `'try.fail' → '.fail'`, `'check.fail' → '.fail'`.

Loop mechanics: `try` has two incoming wires on `try.main` — one from the Activity entry, one from the label `start`. Per invocation exactly one fires. The first invocation comes from the entry; subsequent iterations come via the link from `check`, through the label, into the convergence input `try.main`.

#### 6.11.3 Forward link

```js
const wf = nrail((r) => {
  r.entry('main');
  r.step('X', fnX, 'main', ['main', 'special']);
  r.link('merge', 'special');         // pending: special → merge.in
  r.step('Y', fnY, 'main', 'main');
  r.label('merge', 'main');           // resolves the pending link immediately
});
```

Walk-through. Same notation as §6.11.2.

- `r.entry('main')`
  - produces: `(main, '.main')`
  - Live-Set: `[(main, '.main')]`
- `r.step('X', fnX, 'main', ['main', 'special'])`
  - consumes: `(main, '.main')`; wire `'.main' → 'X.main'`
  - produces: `(main, 'X.main')`, `(special, 'X.special')`
  - Live-Set: `[(main, 'X.main'), (special, 'X.special')]`
- `r.link('merge', 'special')`
  - consumes: `(special, 'X.special')`; `merge` is not yet a known label, so the source `'X.special'` is appended to the pending-links list under `merge`. No wire is created yet.
  - produces: nothing
  - Live-Set: `[(main, 'X.main')]`
- `r.step('Y', fnY, 'main', 'main')`
  - consumes: `(main, 'X.main')`; wire `'X.main' → 'Y.main'`
  - produces: `(main, 'Y.main')`
  - Live-Set: `[(main, 'Y.main')]`
- `r.label('merge', 'main')`
  - registers the label and immediately resolves the pending link: wire `'X.special' → 'merge.in'`.
  - produces: `(main, 'merge.main')`
  - Live-Set: `[(main, 'Y.main'), (main, 'merge.main')]`
- Build end: exit `main` is created; both `'Y.main'` and `'merge.main'` are wired to `'.main'` (convergence at the exit).

The forward link lets a step (`X`) send its output to an anchor that is declared later in the builder. The link is resolved as soon as the matching label is registered — the pending-links list is therefore almost always empty at build end; if it is not, that signals a typo in the label name (`UNKNOWN_LABEL`).

### 6.12 When to use n-Rail

`nrail(...)` is the right choice when:

- the flow has a **linear main sequence** with multiple parallel outcome tracks (typically cleanup, retry, notification),
- the topology reads naturally as "tracks running left to right",
- the value over `activity(...)` is the saved `a.wire(...)` calls.

For heavily branched, irregular topologies or for workflows that rely on uncaught atom throws, `activity(...)` directly is preferable.

---

## 7. Railway

`railway(builderFn)` is a convenience factory for the Trailblazer-style two-track pipeline (`success`/`failure`). It is a thin wrapper over `nrail(...)` (§6): every `railway` Activity can be expressed as an `nrail` Activity with two rails, automatic exception catching via `catchTo` (§11), and three shorter builder methods. The result is a fully ordinary Activity — `__rail_kind__: 'activity'`, `inputs: ['success']`, `outputs: ['success', 'failure']`.

```js
import { railway, flow } from './rail.js';

const sendMessage = railway((r) => {
  r.step('validate', async (ctx) => {
    if (!ctx.roomId) throw new Error('roomId required');
    if (!ctx.body)   throw new Error('body required');
  });

  r.step('encrypt', async (ctx, local, runInfo) => {
    ctx.payload = await encrypt(ctx.body, { signal: runInfo.signal });
  });

  r.fail('logError', async (ctx) => {
    if (ctx._error) {
      console.error('step failed:', ctx._error);
    }
  });
});
```

Three builder methods, all with the same user-function signature `fn(ctx, local, runInfo) → void`:

| Method             | Routes to            | Throw behaviour                                                 |
|--------------------|----------------------|-----------------------------------------------------------------|
| `r.step(name, fn)` | `success` on success | caught → routes to `failure` (`ctx._error` set)                 |
| `r.pass(name, fn)` | `success`            | caught → routes to `success` (`ctx._error` set)                 |
| `r.fail(name, fn)` | `failure`            | caught → routes to `failure` (`ctx._error` set, overwriting any prior) |

### 7.1 Definition

`railway` is equivalent to:

```js
function railway(builderFn) {
  return nrail((r) => {
    r.entry('success');
    builderFn({
      step: (name, fn) =>
        r.step(name, catchTo(fn, 'failure'), 'success', ['success', 'failure']),
      pass: (name, fn) =>
        r.step(name, catchTo(fn, 'success'), 'success', 'success'),
      fail: (name, fn) =>
        r.step(name, catchTo(fn, 'failure'), 'failure', 'failure'),
    });
  });
}
```

Three consequences fall out of the definition:

1. **The Live-Set mechanism (§6.7) places the steps.** Steps on rail `success` consume the success rail; steps on rail `failure` consume the failure rail. After each `r.step`, both `success` and `failure` are live; subsequent `r.step` calls consume `success`, subsequent `r.fail` calls consume `failure`. Convergence on the failure rail produces a clean cleanup chain.
2. **Throw routing is via `catchTo`, not via builder magic.** Each method's `catchTo` wrapper catches non-library exceptions and routes them to the configured exit. Library errors (`RailError`, `RailAggregateError`) propagate unchanged (§2.1).
3. **`r.fail` before `r.step` is rejected at the n-Rail layer.** Without a prior `r.step` to produce a `failure` rail entry, `r.fail` raises `RAIL_NOT_LIVE` from n-Rail. No separate `FAIL_BEFORE_STEP` error is needed.

### 7.2 Topology

Concretely, the example from above:

```js
railway((r) => {
  r.step('a',         /* fn */);
  r.fail('cleanupA',  /* fn */);
  r.step('b',         /* fn */);
  r.fail('cleanupB',  /* fn */);
  r.step('c',         /* fn */);
});
```

produces this topology (one node per declaration, convergence on the failure track):

```
                  a.success      b.success      c.success
.success ──────→ a ──────────→ b ──────────→ c ──────────→ .success
                 │              │              │
                 │ a.failure    │ b.failure    │ c.failure
                 ▼              ▼              │
              cleanupA ───→ cleanupB           │
                            (in: failure)      │
                             │                 │
                             │ cleanupB.failure│
                             ▼                 ▼
                                          .failure
                          (convergence: cleanupB.failure
                           and c.failure both end at .failure)
```

The arrow from `b.failure` and the arrow from `cleanupA.failure` both end at `cleanupB.failure` — convergence on a single atom input endpoint (§6.7). Similarly, `cleanupB.failure` and `c.failure` both end at `.failure` (the Activity's failure exit).

- Throw from `a` flows through `cleanupA`, then `cleanupB`, then to `.failure`.
- Throw from `b` flows through `cleanupB` only, then to `.failure`.
- Throw from `c` goes directly to `.failure` (no intervening `r.fail`).

### 7.3 Error propagation on track switch

When `r.step` throws and the run switches to the failure track, `catchTo` sets `ctx._error` to the thrown error (§10.2). The first `r.fail` step on the failure track receives this ctx. It can inspect `ctx._error`, mutate ctx (e.g. `delete ctx._error` to clear, or add diagnostic fields), and the mutated ctx flows to the next failure-track step.

If no `r.fail` processes it, the ctx (still carrying `_error`) reaches the `failure` exit unchanged.

A throw inside `r.pass` or `r.fail` is caught by their `catchTo` wrapper and routed to their declared output with `ctx._error` set (overwrite semantics — see §10.2).

For failures that should affect control flow, use `r.step`. `r.pass` and `r.fail` always route to their declared exit; the captured error is informational for downstream nodes or for the caller via `result.ctx._error`.

### 7.4 Properties of the resulting node

- `__rail_kind__: 'activity'`
- `inputs: ['success']`
- `outputs: ['success', 'failure']`

### 7.5 Validation rules

`railway(builderFn)` is implemented as a thin mechanical layout over `nrail(...)` with two fixed tracks (§6, §7). The validation rules are therefore those of `nrail` (§6.10) restricted to the railway's fixed track set. In particular, the activity-level whole-graph walk (§5.6) runs at the end of the build just as for any other activity.

### 7.6 When to use Railway

Use `railway(...)` when the whole activity follows the two-track shape — a success rail of operations with optional cleanup-and-enrich steps on the failure rail. For three or more outcome tracks, use `nrail(...)` (§6) directly; for irregular topologies, `activity(...)`.

---

## 8. Parallel

The Parallel node is a group node that runs its branches concurrently and collects their results. Where Activity walks a graph of wires sequentially, Parallel runs independent branches without any internal wiring between them. An optional **merge node** post-processes the aggregated branch results before the parallel returns.

```js
import { activity, parallel, step } from './rail.js';

const fan = parallel({
  profile: profileActivity,    // an activity (Rail-Node)
  keys:    keysActivity,
  audit:   step(auditFn),      // or a single-input step-node
});

const wf = activity((a) => {
  a.entry('in');
  a.exit('ok');
  a.exit('failed');
  a.addNode('parallel', fan);
  a.addNode('evaluate', step(evaluateFn));

  a.wire('.in',                 'parallel.in');
  a.wire('parallel.out',        'evaluate.success');
  a.wire('evaluate.success',    '.ok');
  a.wire('evaluate.failure',    '.failed');
});
```

The example above places the discriminating `evaluate` step as a sibling of `parallel` inside the activity. The same flow can be expressed with `evaluate` as the parallel's merge node — see §14.5 — in which case the parallel's outputs are `['success', 'failure']` and the activity wires `parallel.success`/`parallel.failure` directly to the exits.

The branches are an object mapping branch names to nodes. Each branch is itself a Node.

**Signature.** `parallel(branches, merge?)` — `merge` is optional.

- `__rail_kind__: 'parallel'`
- `inputs: ['in']`
- `outputs`:
  - without a merge node: `['out']`
  - with a merge node: the merge node's `outputs` (which may be multiple, e.g. `['success', 'failure']`)

The merge node lets the parallel construct expose multiple typed outcomes — a common need when the aggregated branch results need a final discrimination (e.g. evaluating combined results and deciding success vs failure). Functionally it is equivalent to placing a step right after the parallel in the surrounding activity, but it is **structurally part of the parallel**: callers cannot wire between the parallel's internal `'out'` and the merge's input; the parallel and the merge form an indivisible composite. See §14.5 for an example.

#### Build-time validation

- `branches` must be a plain object.
- `branches` must be non-empty.
- Each key (the branch name) must satisfy §5.1.
- Each value must be a Rail-Node (`isRailNode(...)`) with exactly one input. Multi-input nodes cannot be branches directly because Parallel activates each branch unconditionally; wrap them in `pin(node, 'entryName')` first.
- If `merge` is given: it must be a Rail-Node (`isRailNode(...)`) with exactly one input. Multi-input merge nodes must be pre-wrapped in `pin(...)`.
- No branch name may be `'__merge__'` (reserved, §5.1).

#### Activation

When the Parallel node is activated, all branches start concurrently. Each branch receives **its own shallow copy** of `ctx` (`{ ...ctx }`), its own `local` slot from `local.branches[branchName]`, the same `runState` reference, and a `path` extended with the branch name. Every branch is invoked at its single declared input. Branches cannot interfere with each other's ctx mutations: each works on a separate top-level frame (nested objects are still shared by reference — §2.2).

#### Result collection

The Parallel node awaits all branches via `Promise.allSettled`. Two outcomes are possible:

- **All branches fulfilled.** The Parallel node mutates ctx in place so that downstream nodes see a plain object keyed by branch name, **with each branch's final ctx as the value** — every branch's full state, including all fields it inherited from the incoming ctx via the shallow copy made at activation, is preserved under its branch name:

  ```js
  // Incoming ctx: { userId: 'u-42', requestId: 'r-7' }
  // After branches complete, ctx becomes:
  ctx = {
    profile: { userId: 'u-42', requestId: 'r-7', /* + profile branch's mutations */ },
    keys:    { userId: 'u-42', requestId: 'r-7', /* + keys    branch's mutations */ },
    audit:   { userId: 'u-42', requestId: 'r-7', /* + audit   branch's mutations */ },
  }
  ```

  No data is lost in the transition: pre-parallel fields are accessible through any branch's sub-ctx (e.g. `ctx.profile.userId`). Branches did not share ctx state during execution — each worked on its own shallow copy — so a field a branch wrote is visible only under that branch's name. Branch exits are not preserved: each branch returns its own exit string internally, but only "fulfilled vs rejected" is visible to the Parallel node. If branches have multiple outputs whose distinction matters, model the branch as an Activity with a single exit and place the discrimination logic inside.

  - **Without a merge node.** The Parallel node returns the exit string `'out'`. The aggregated ctx is the final ctx of the parallel position.
  - **With a merge node.** After the aggregation above, the Parallel node invokes the merge node with the aggregated ctx as its input, using its own `local._merge` slot (see §15.6) and a path extended by the reserved marker `'__merge__'`. The merge node mutates the ctx in place (typically replacing it with a domain-shaped object after inspecting the branch results) and returns one of its declared outputs. That output becomes the Parallel node's exit, and the merge node's final ctx becomes the Parallel node's final ctx. A throw from the merge node propagates out of the Parallel node as in any atom.

- **Any branch rejected.** The Parallel node throws a `RailAggregateError` whose `branchErrors` field maps each failing branch name to its rejection (§12.4). Fulfilled branches' ctxes are discarded — the aggregate error does not carry them, and the running ctx is *not* mutated. **The merge node is not invoked when any branch rejects**; aggregation precedes the merge unconditionally, and a failed aggregation aborts the construct before the merge runs.

When a branch rejects, the Parallel node aborts the internal cancellation signal **at that moment** so sibling branches still running see `runInfo.signal.aborted === true` (§13.4) and can exit cooperatively. It then waits for `Promise.allSettled` to collect every branch's final state before constructing the aggregate. The abort fires on the *first* rejection across branches; subsequent rejections find the signal already aborted (`abort()` is idempotent).

**Cooperative cancellation caveat.** `Promise.allSettled` waits for every branch to settle, regardless of the internal signal. Branches that consult `runInfo.signal` can exit promptly when a sibling fails; branches that do not — for example, code that runs a blocking timer or awaits an external promise without signal-awareness — run to their natural end. As a consequence, the aggregate error is only thrown once the slowest branch has finished, even if the first failure happened much earlier. Library code cannot force-terminate a running branch; this is by design (cooperative cancellation, §13.4). Branch authors that need bounded shutdown time must wire `runInfo.signal` into their I/O calls.

The internal walk is sketched in §15.6.

### 8.1 Validation rules

Eager checks at the `parallel(branches, merge?)` call:

- `branches` is a plain object with at least one entry (otherwise `MISSING_NODES`).
- Branch names are non-empty and unique within the `branches` object — JS object keys make uniqueness automatic; empty names raise `INVALID_NAME`. No branch name may be `'__merge__'` (otherwise `INVALID_NAME`).
- Each branch value is a Rail-Node (otherwise `NOT_A_NODE`).
- Each branch node has exactly one input (`node.inputs.length === 1`); multi-input branches must be pre-wrapped in `pin(...)` (otherwise `MULTI_INPUT_NODE`).
- If `merge` is given: `isRailNode(merge)` (otherwise `NOT_A_NODE`); `merge.inputs.length === 1` (otherwise `MULTI_INPUT_NODE`).

Parallel has no whole-graph walk of its own: each branch and the merge node are single Rail-Nodes, and any nested group nodes inside them have already been validated by their own builders. The eager checks above are the complete `parallel(...)` validation set.

---

## 9. Flow

```js
import { flow } from './rail.js';

const sendMessageFlow = flow('sendMessage', sendMessage);
const result = await sendMessageFlow.run(ctx, opts);
```

`flow(name, node)` returns a plain object with `name`, `node`, `run`, `toMermaid` properties.

- `name: string` — diagnostic name, used by the default logger and in error messages. Must satisfy the name rules in §5.1; otherwise `RailBuildError(INVALID_NAME)`.
- `node` — must be a Rail-Node (`isRailNode(node) === true`); otherwise `RailBuildError(NOT_A_NODE)` is thrown by `flow(...)`. The node must have exactly one input (`node.inputs.length === 1`). Multi-input nodes cannot be held directly; wrap them in `pin(node, 'entryName')` first. Violation raises `RailBuildError(MULTI_INPUT_NODE)`.
- The flow holds the node by reference and does not modify it. `flow(name, node)` performs **argument-level checks** on its inputs — `INVALID_NAME` on `name`, `NOT_A_NODE` on `node`, `MULTI_INPUT_NODE` if `node.inputs.length !== 1` — but does **not** re-walk the held node's internal graph. All three raise `RailBuildError`; they are semantic violations specific to the `flow(...)` call site, not the JavaScript-level shape errors described in §1.5 (which would be `TypeError`). Built-in builders return fully-validated nodes (§1.5, plus per-kind validation in §3, §4.1, §5.6, §6.10, §7.5, §8.1), so passing a builder result to `flow(...)` is always safe. Nodes assembled by hand (custom kinds) are the author's responsibility — `flow(...)` accepts any value that satisfies `isRailNode` with a single input; the library does not re-walk or re-validate the custom kind's internal structure at `flow(...)` or `flow.run(...)` time.

Run-time options are supplied per call to `flow.run(ctx?, opts?)` — both arguments are optional. `ctx` defaults to `{}` when omitted or `undefined`; `opts` defaults to all-defaults:

```js
opts = {
  maxSteps:           number,                       // default 1000
  tracer:             ((entry, event) => void) | undefined,
  logger:             ((entry) => void) | undefined,
  tracerErrorPolicy:  'swallow' | 'throw',          // default 'swallow'
  loggerErrorPolicy:  'swallow' | 'throw',          // default 'throw'
  signal:             AbortSignal | undefined,      // cooperative cancellation
  killSignal:         AbortSignal | undefined,      // kill switch
}
```

Callers that want shared defaults across runs wrap `flow.run` in their own thin function:

```js
const runMain = (ctx, opts) => f.run(ctx, { tracer: prodTracer, ...opts });
```

See §13 for the semantics of each field.

The flow object is stateless: all run-time data lives in the closure of `run(...)`. The same flow object can be invoked many times, including concurrently.

`flow.run(ctx, opts)` allocates a fresh `runState` and invokes the held node as `node._invoke(node.inputs[0], ctx, {}, runState, [])` — a fresh empty `local` and an empty `path` (the top-level position has no name; the flow's name lives in `runState.flowName`). `_invoke` returns the exit string and mutates the passed-in `ctx` in place; `flow.run` constructs the `RunResult` from this exit, the mutated `ctx`, and `runState.trace`.

#### Error propagation at the run boundary

`flow.run` wraps its top-level `_invoke` call in a `try/catch` purely to classify and tag the thrown value. When the catch fires:

- **`RailError`** (i.e. `RailRuntimeError` or `RailBuildError`) — `e.flowName` is set to `runState.flowName` if not already set. The error is re-thrown unchanged in class and code.
- **`RailAggregateError`** — same: `flowName` is set if missing; the keyed `branchErrors` and its values (each itself a `RailError` or nested `RailAggregateError`) are left as-is. The throw-site (§12.4) already constructed the aggregate with `branchErrors` and message.
- **Any other thrown value** — wrapped in `new RailRuntimeError('UNHANDLED_THROW', { cause: e, flowName: runState.flowName })` and re-thrown.

Library errors do **not** carry the run trace or the ctx. The trace is the *clean execution path* and is accessible during the run via tracers and loggers; once a library error propagates out of `flow.run(...)`, the `runState` is no longer reachable. Callers that need to inspect the run state at the point of failure register a tracer.

Inner runners propagate without re-classifying: `activity.doInvoke` re-throws unchanged, and `parallel.doInvoke` aggregates rejections into a `RailAggregateError` (§8). The single classification point is the top-level `flow.run` boundary.

#### `RunResult`

```js
{
  ctx:   Object,         // final ctx after the run
  trace: TraceEntry[],   // ordered list of step executions (= runState.trace)
  exit:  string,         // the exit produced by the top-level node
}
```

The library has no built-in notion of "success" or "failure" for a `RunResult`. Reaching an exit *is* a successful run; what the exit means is a domain question the caller answers by inspecting `exit`. At the API boundary:

- **Promise resolves** with a `RunResult` → the run reached an exit; the `exit` field says which.
- **Promise rejects** with a `RailRuntimeError` or a `RailAggregateError` (§12.4) → a library error. The error carries `flowName`, `code`, and (where applicable) `cause` and `details`; it does **not** carry the trace or the ctx (§12.1). Callers that need post-mortem state inspection register a tracer (§13.6).

To detect whether the final ctx carries a domain-level error from a caught throw, check `result.ctx._error` (§10.2).

#### `TraceEntry` — authoritative definition

All references in the spec to "TraceEntry" point here.

```js
TraceEntry = {
  path:      string[],     // position of the node in the run, as a list of names
  kind:      string,       // the node's __rail_kind__
  cycle:     number,       // invocation count at this position, including this call;
                           // first invocation: 1, second: 2, etc.
  entry:     string,       // input port through which the node was activated
  ctx:       Object,       // shallow snapshot of ctx at push time
  local:     Object,       // shallow snapshot of local at push time (includes
                           // post-increment _cycles)
  startTime: number,       // ms epoch when invokeNode pushed the entry
  endTime?:  number,       // ms epoch when invokeNode completed the entry
  exit?:     string,       // chosen output, set on successful completion
}
```

Every TraceEntry pushed to a run's trace has the required fields populated at push time (`path`, `kind`, `cycle`, `entry`, `ctx`, `local`, `startTime`). The trailing fields (`endTime`, `exit`) are filled in only on **successful** completion. If `doInvoke` throws, the throw propagates, the run terminates, and the entry remains in the trace with `endTime` and `exit` undefined — that absence marks the position where the run died. There is no `error` field on TraceEntry; the thrown error itself is delivered to the `flow.run(...)` caller as a JavaScript throw with `flowName`, `code`, `message`, and optional `cause`.

Both `ctx` and `local` are shallow snapshots taken at the moment the entry is pushed. They allow tracers reading the trace to inspect domain state and position state without risk of later mutations changing what the entry shows (modulo the usual nested-object reference sharing).

The dotted-path string `path.join('.')` is computed by consumers when needed; the trace itself stores the array form because that is what `invokeNode` works with.

`flow.toMermaid(opts?)`:

- Returns a Mermaid `flowchart LR` string of the held node, using the flow's top-level name as the diagram's label.
- Delegates to `node.toMermaid(flow.name, opts)` when the held node exposes that hook (built-in `activity`, `parallel`, and `pin` do); otherwise renders the held node with the default atomic rendering — entry, node box, and one exit per declared output. See §2.4 and §15.8.

---

## 10. Utility functions

Functions for introspection and for constructing library-typed contexts. Not builders.

### 10.1 `isRailNode(value): boolean`

Membership test for any Rail-Node — built-in, externally authored, or assembled as a plain object:

```js
isRailNode(value) === (value?.__rail_type__ === 'node')
```

`__rail_type__: 'node'` is the explicit opt-in marker (§2): any value bearing it is treated as a Rail-Node by the library. The full set of properties a Node must expose (`__rail_kind__`, `inputs`, `outputs`, `_invoke`) is documented in §2.1; setting `__rail_type__` without providing the other properties is a custom-kind authoring bug whose diagnosis surfaces at the first use of the missing property — the library does not defensively validate this, consistent with the custom-kind responsibility rule (§1.5).

### 10.2 Reserved ctx fields

#### Exception-bearing ctx

When `step`, `pass`, `fail`, or any user function wrapped with `catchTo` catches a non-library exception, it places the error on the ctx under a reserved field:

```js
ctx._error = <error>;
```

The error is stored by reference. Downstream nodes read `ctx._error` like any other field. This mirrors Trailblazer's `Rescue { ctx[:exception] = ... }` pattern.

If the incoming ctx already had a `_error` field, the new error overwrites it. This matches the standard behaviour that an exception inside an exception-handler shadows the original.

#### Parallel-results ctx

The Parallel node produces a plain object keyed by branch name (§8); there is no type marker on the ctx. The consumer reads `ctx.branchName` to access each branch's final ctx. If a merge node is configured on the parallel, the merge node sees this `{ branchName: branchCtx, ... }` ctx as its input and typically replaces it with a domain-shaped ctx; consumers downstream of the merge then see the merge's output ctx, not the aggregated branch ctxes.

---

## 11. User functions for atomic builders

The five atomic builders (`atom`, `nstep`, `step`, `pass`, `fail`) wrap a user-supplied function. This section describes the shared conventions for that function.

### Shared signature

```js
async fn(ctx, local, runInfo) → <return value>
```

- `ctx` — the running context entering the node. Passed by reference; mutations are visible to the next node (§2.2 "Mutation model").
- `local` — the position-local state, a direct reference to the parent's storage slot (§2.3).
- `runInfo` — read-only library context for this invocation; see below.
- The return value's shape depends on the builder.

Trailing parameters may be omitted.

### Builder-specific returns

| Builder                | Return                  | Effect                                                  |
|------------------------|-------------------------|---------------------------------------------------------|
| `atom(fn, opts)`       | `string`                | the chosen exit, must be in `node.outputs`              |
| `nstep(fn, ins, outs)` | `string \| undefined \| null` | single-output: nullish (`undefined`/`null`) or the output name (all yield that output); multi-output: must return one of the declared outputs |
| `step(fn)`             | `void`                  | exit chosen by throw vs normal return                   |
| `pass(fn)`             | `void`                  | exit is always `'success'`                              |
| `fail(fn)`             | `void`                  | exit is always `'failure'`                              |

User functions mutate the incoming ctx in place — replacing the running ctx with a different object is not a supported operation (§2.1). For `atom`, the returned string must be one of the node's declared `outputs`; otherwise `RailRuntimeError(UNKNOWN_OUTPUT_AT_RUNTIME)`. For `nstep`, the same `UNKNOWN_OUTPUT_AT_RUNTIME` rule applies; a nullish return (`undefined` or `null`) is accepted only at single-output nodes and resolves to the single declared output. For `step`, `pass`, `fail`, the exit is determined by the builder's convention, not by a return value — these functions return `void`.

### `runInfo`

A plain object carrying read-only context about the current invocation.

- `signal: AbortSignal | undefined` — the combined cancellation signal (§13.4).
- `flowName: string` — top-level flow name.
- `traceEntry: TraceEntry` — the trace entry for this invocation (§9). During the call, `endTime` and `exit` are `undefined`; they are filled in by `invokeNode` after the function returns successfully. If the function throws, the entry stays unfilled and the run terminates.

A function reads its own position from `traceEntry`:

```js
fn(ctx, local, runInfo) {
  const path  = runInfo.traceEntry.path;
  const name  = path[path.length - 1];
  const cycle = runInfo.traceEntry.cycle;
}
```

`traceEntry.ctx` and `traceEntry.local` are shallow snapshots taken when the entry was pushed, distinct from the live references. The fields are read-only by convention; the library does not freeze them.

### Working with `local`

`local` is a direct reference to the parent's storage slot. The function may mutate it in place:

```js
// step's user function — mutate ctx and local, return nothing
fn(ctx, local, runInfo) {
  local.counter = (local.counter ?? 0) + 1;
}
```

Reassigning the parameter has no effect on the parent's storage (standard JS). To replace the whole local, do an in-place clear-and-rebuild:

```js
for (const k in local) delete local[k];
Object.assign(local, { counter: 5 });
```

`invokeNode` writes `local._cycles` (§2.2) — the position's invocation count. User code can read it but should not write it. A clear-and-rebuild that deletes everything removes `_cycles` along with the user fields; `invokeNode` will start counting from `1` again on the next invocation. If you want to keep the cycle count across a rebuild, preserve it explicitly:

```js
const keepCycles = local._cycles;
for (const k in local) delete local[k];
Object.assign(local, { counter: 5, _cycles: keepCycles });
```

### ctx ownership

The running ctx is the programmer's domain object. The library does not reserve any field names — user code is free to use any keys. The library does, however, write into ctx in a few well-known cases:

- `step`, `pass`, `fail`, and any user function wrapped with `catchTo` write `ctx._error` when catching a non-library exception (§10.2). User code may read this field freely, and may also write it; library writes happen on each catch and overwrite whatever was there.
- `parallel` replaces the running ctx with `{ branchName: branchCtx, ... }` for downstream nodes (§8); branch names are user-chosen and form an ordinary object.

The `_error` name follows the leading-underscore convention for library-written fields (§1.5), but the field is not protected — colliding with it just means library and user may overwrite each other's values.

### Wrapping user functions: `catchTo`

`catchTo(fn, exitName)` is a user-function-level wrapper that catches non-library exceptions and routes them to a specified exit. It is the library's single exception-handling mechanism — it wraps a *function* and produces a function suitable for `atom`, `nstep`, or any other atomic builder.

```js
import { catchTo } from './rail.js';

function catchTo(fn, exitName) {
  return async function (ctx, local, runInfo) {
    try {
      return await fn(ctx, local, runInfo);
    } catch (err) {
      if (err instanceof RailError) throw err;
      ctx._error = err;
      return exitName;
    }
  };
}
```

Behaviour:

- `RailError` and `RailAggregateError` are never caught — they propagate (§2.1).
- On caught non-library exception: `ctx._error = err`, returns `exitName`.
- On normal return: passes through the wrapped function's exit string unchanged.

**Use case:** providing throw-to-exit routing on a step in an arbitrary atomic builder. Typical with `nstep` and `nrail`'s `r.step` (which do not catch by default):

```js
const validate = nstep(catchTo(validateFn, 'failure'), 'main', ['main', 'failure']);
// Throws in validateFn → routed to 'failure', ctx._error set.
```

**Relation to atomic builders.** `catchTo` is the only catching mechanism in the library. `step`, `pass`, `fail` are built on it (§3.3–§3.5). For inline atomic builders that don't catch by default (`atom`, `nstep`, `r.step` in n-Rail), wrap your function with `catchTo` to opt in.

**Multi-class routing.** `catchTo` routes every non-library exception to the same exit. For routing different error classes to different exits, write a plain user function that does the classification — no library wrapper is needed:

```js
async function fetchWithRouting(ctx, local, runInfo) {
  try {
    ctx.data = await fetch(ctx.url);
    return 'ok';
  } catch (err) {
    if (err instanceof RailError) throw err;
    ctx._error = err;
    if (err instanceof NetworkError) return 'retry';
    if (err instanceof TimeoutError) return 'timeout';
    return 'fail';
  }
}

r.step('fetch', fetchWithRouting, 'main', ['ok', 'retry', 'timeout', 'fail']);
```

The classification logic is visible at the use site; the library does not need a second wrapper for this. `exitName` (in plain `catchTo`) and the returned strings (in custom wrappers) must be valid outputs of the eventual atom; otherwise `RailRuntimeError(UNKNOWN_OUTPUT_AT_RUNTIME)` at runtime.

### Rules

- User functions mutate the incoming ctx in place. There is no return-channel for ctx — `atom`'s user function returns the exit string, `step`/`pass`/`fail`'s functions return nothing. The exit is determined by `atom`'s return value or the builder's convention (§3).
- To replace the whole ctx (rarely needed; usually you just set or delete specific fields), do an in-place clear-and-rebuild, analogous to `local`:
  ```js
  for (const k in ctx) delete ctx[k];
  Object.assign(ctx, newCtx);
  ```
- Reusable steps that want to layer fields should `Object.assign(ctx, { foo: bar })` or just set fields directly (`ctx.foo = bar`).
- User functions must not throw `RailError` or `RailAggregateError`; library errors are the library's to produce. For non-library exceptions: `atom`'s and `nstep`'s user functions follow §2.1 (throws propagate as `UNHANDLED_THROW` and terminate the run). `step`, `pass`, and `fail` wrap the user function with `catchTo` (§3.3–§3.5) so caught throws are routed to a fixed exit with `ctx._error` set; the underlying atom never sees the throw.
- `parallel` branches operate on shallow copies of the incoming ctx (§8) — mutations in one branch do not leak to siblings at the top level. Nested mutations are still shared by JS reference semantics.

---

## 12. Errors

The library produces a single error class hierarchy rooted at `RailError`:

- `RailError` (`RailBuildError`, `RailRuntimeError`, `RailAggregateError`) — all library errors share this superclass, §12.1, §12.2, §12.4.

Use `err instanceof RailError` to test for any library-produced error, single or aggregate.

Failures in user-provided callbacks (logger, tracer) are not library errors; their propagation is controlled by `opts.loggerErrorPolicy` and `opts.tracerErrorPolicy` (§13.6).

### 12.1 `RailError` and `RailRuntimeError`

`RailError` is the abstract superclass for the library's two single-error classes:

```js
class RailError extends Error { }

class RailBuildError   extends RailError { name = 'RailBuildError';   /* + code */ }
class RailRuntimeError extends RailError { name = 'RailRuntimeError'; /* + code, flowName, cause */ }
```

The library never throws a bare `RailError`. The class exists so callers and library helpers (such as `catchTo` and user-written exception routers) can detect "any library-level error" with a single `instanceof RailError` check.

`RailAggregateError` (§12.4) also extends `RailError`, so `err instanceof RailError` covers every library-produced error — single or aggregate. The aggregate exposes an `errors` array (`Object.values(branchErrors)`) for callers that want a flat iteration view, mirroring the shape of the native `AggregateError` without inheriting from it.

**Constructor contract.** Both subclasses share a uniform constructor shape:

```js
new RailRuntimeError(code, options?)
new RailBuildError(code, options?)
```

where:

- `code: string` — required. One of the codes catalogued in §12.1 (runtime) or §12.2 (build).
- `options?: { message?: string, flowName?: string, cause?: Error, details?: object }` — optional. All fields optional individually:
  - `message` — explicit human-readable message. If omitted, the library composes one from the code and any `details`/`cause` (see "Diagnostic message conventions" below).
  - `flowName` — set by throw-sites that have `runState.flowName` in scope. Throw-sites without that context omit it; `flow.run`'s classification boundary (§9) fills it in if missing before the error escapes.
  - `cause` — the originally thrown value (typically for `UNHANDLED_THROW`). Standard JS error-cause convention.
  - `details` — structured data relevant to the code (e.g. `{ returned: 'maybe', expected: ['success', 'failure'] }` for `UNKNOWN_OUTPUT_AT_RUNTIME`; `{ ref: 'foo.bar' }` for `UNRESOLVED_WIRE_REFERENCE`). Implementation-defined per code; tests assert presence of the relevant fields, not exact shape.

All call-sites in the spec's implementation sketches conform to this signature. Both call forms are valid and equivalent for the same call-site context:

```js
new RailRuntimeError('KILLED')                                  // minimal
new RailRuntimeError('KILLED', { flowName: 'sendMessage' })      // with options
new RailRuntimeError('UNHANDLED_THROW', { cause: err, flowName: 'sendMessage' })
```

Throw-sites with `runState.flowName` in scope set `flowName` directly; throw-sites without scope (rare, e.g. parallel branch wrapping before flow.run's classification boundary) omit it and rely on `flow.run` (§9) to fill it in if missing.

**`RailRuntimeError` shape:**

```js
class RailRuntimeError extends RailError {
  name = 'RailRuntimeError';
  code: string;                     // see codes below
  flowName: string;                 // top-level flow name
  cause?: Error;                    // originally thrown error, if any
  details?: object;                 // code-specific context (see diagnostic conventions)
}
```

Throw-sites construct the error with `code` and any applicable options (`flowName`, `cause`, `details`). Library errors do **not** carry the run trace or the ctx — the trace documents the *clean* execution path of a run and is observable via tracers and loggers during execution; once a library error propagates out of `flow.run(...)`, the `runState` is gone. Callers that need post-mortem trace inspection register a tracer.

Codes:

| Code                          | When                                                                                          |
|-------------------------------|-----------------------------------------------------------------------------------------------|
| `UNKNOWN_OUTPUT_AT_RUNTIME`   | A node's `doInvoke` returned an exit name not in its declared `outputs` (e.g. `atom`).        |
| `UNHANDLED_THROW`             | A non-library value escaped a node — wrapped by `flow.run` (at the top level) or by `parallel` (per rejected branch). See §2.1. |
| `STEP_BUDGET_EXCEEDED`        | `runState.trace.length` exceeded `runState.maxSteps` (default 1000; see §13.5).                |
| `KILLED`                      | The caller's `opts.killSignal` fired before a node started. See §13.4. (Internal aborts from sibling branches do **not** raise `KILLED` — they aggregate as `RailAggregateError`.) |
| `INTERNAL`                    | A library invariant was violated (defensive code path). Reachable only via library bugs, direct `_invoke` calls, or custom-kind extensions; the error message identifies which invariant. |

**Diagnostic message conventions.** Where the library can name useful diagnostic context, it includes it in the `message`:

- `UNKNOWN_OUTPUT_AT_RUNTIME` lists the returned value and the declared outputs of the node: e.g. `"node 'validate' returned 'maybe'; expected one of: success, failure"`. If the node has a registered position (i.e. is being invoked through `invokeNode` with a non-empty `path`), the dotted path is included for locatability.
- `UNHANDLED_THROW` uses `cause` to carry the original thrown value; the `message` summarises the cause's `message` (or `String(cause)` for non-Error throws) plus the position where the throw escaped.
- `STEP_BUDGET_EXCEEDED` reports the configured `maxSteps` value.
- `KILLED` reports that the user-supplied `killSignal` triggered; no further detail needed.
- `INTERNAL` names the invariant that was violated.

These conventions are recommendations for the reference implementation; tests assert the error `code` and the presence of contextual fields (e.g. `cause`), not exact message strings.

### 12.2 `RailBuildError`

The error class for build-time validation. Covers builder-method violations inside `activity(...)` / `railway(...)` / `nrail(...)` closures, and factory-argument violations for `atom`, `nstep`, `step`, `pass`, `fail`, `parallel`, `pin`, `flow`. All build-time errors are raised per the eager-validation rule (§1.5).

```js
class RailBuildError extends RailError {
  name = 'RailBuildError';
  code: string;
  // additional fields per code
}
```

Codes (catalog of all build-time codes raised by the library):

| Code                            | When                                                                                                                |
|---------------------------------|---------------------------------------------------------------------------------------------------------------------|
| `NOT_A_NODE`                    | A non-Rail-Node value where a Rail-Node was required (`a.addNode`, `flow`, `parallel`, `pin`).                     |
| `INVALID_NAME`                  | A user-supplied name was empty, whitespace-only, or contained the reserved character `.`. See §5.1.              |
| `UNRESOLVED_WIRE_REFERENCE`     | A wire string failed to resolve to a known endpoint (unknown sub-node, port, entry, or exit name).                 |
| `WIRE_DIRECTION_INVALID`        | `a.wire(src, tgt)` source is not usable as a source, or target is not usable as a target.                          |
| `DUPLICATE_NODE_NAME`           | A sub-node, step, or label name was reused within the same builder closure (`a.addNode(...)`, `r.step(...)`, `r.label(...)`, etc.). Distinct from `DUPLICATE_INPUT`/`DUPLICATE_OUTPUT`, which apply to port duplicates within `a.entry(...)`/`a.exit(...)` or `atom`'s `inputs`/`outputs`. |
| `UNUSED_PORT`                   | A sub-node output declared in `outputs` has no outgoing wire from this activity. Raised by the group builder's whole-graph walk.              |
| `UNREACHABLE_NODE`              | A sub-node has no incoming wire on any of its inputs and cannot be reached. Raised by the group builder's whole-graph walk.                   |
| `MULTIPLE_OUTGOING_WIRES`       | A source endpoint already has an outgoing wire.                                                                    |
| `MISSING_INPUTS`                | A node was declared with no inputs: `atom(fn, { inputs: [] })`, an activity with no `a.entry(...)` declarations, or `nrail`'s `r.entry(...)` called with no names. |
| `MISSING_OUTPUTS`               | A node was declared with no outputs: `atom(fn, { outputs: [] })` (or `outputs` missing/non-array), or an activity with no `a.exit(...)` declarations. |
| `DUPLICATE_INPUT`               | A node was declared with the same input name listed twice (`atom` `inputs`, repeated or repeated-within-call `a.entry(...)`). Raised eagerly. |
| `DUPLICATE_OUTPUT`              | A node was declared with the same output name listed twice (`atom` `outputs`, repeated or repeated-within-call `a.exit(...)`). Raised eagerly. |
| `MISSING_NODES`                 | A group builder declared no sub-nodes: `activity((a) => {})` without `a.addNode(...)`, `nrail((r) => { r.entry(...) })` without any `r.step`/`r.addNode`, or `parallel({})` with no branches. |
| `MULTI_INPUT_NODE`              | A node was supplied where a single-input node was required and the node has `inputs.length !== 1`: as `flow(name, node)`'s held node, as a `parallel(...)` branch, or as `parallel(...)`'s merge argument. Use `pin(node, 'entry')`. |
| `ENTRIES_NOT_DECLARED`          | Another `nrail` builder method called before `r.entry(...)`. |
| `ENTRIES_ALREADY_DECLARED`      | `nrail` builder's `r.entry(...)` called a second time. |
| `RAIL_NOT_LIVE`                 | `nrail`'s `r.step`, `r.addNode`, or `r.link` references an input rail not present in the Live-Set. Message lists the available rails. |
| `UNKNOWN_LABEL`                 | `nrail` has pending links at build end whose label was never declared. Message lists the missing and known labels. |
| `UNUSED_LABEL`                  | `nrail` label declared without any incoming link. Message lists the unused label names. |
| `SEALED`                        | A builder method (e.g. `a.addNode(...)`, `r.step(...)`) was called after the builder closure returned. The builder reference was captured outside its lifetime. |
| `ASYNC_BUILDER`                 | A group-builder closure (`activity(...)`, `nrail(...)`, `railway(...)`) returned a non-`undefined` value — typically a Promise from an `async` function. Builders must be synchronous (§5). |

These catch errors at the earliest possible moment — at the calling line, with a stack trace pointing to it — rather than during the whole-graph validation walk or runtime.

### 12.3 No `RunResult` on library errors

When a `RailError` or `RailAggregateError` propagates, the caller does **not** receive a `RunResult` — the run did not terminate at an exit. The thrown error carries `flowName`, `code`, and (where applicable) `cause` and `details`; `RailAggregateError` additionally carries `branchErrors` and its `errors[]` view (§12.4). The library does **not** attach the run trace or the ctx to library errors: trace state is observable during execution via tracers and loggers (§13.6), and the `runState` is no longer reachable once the error has escaped `flow.run(...)`. Callers that need post-mortem trace inspection register a tracer.

For domain-level errors that the flow caught and routed (e.g. via `catchTo`), the run does reach an exit — those are visible on `result.ctx._error` (§10.2), not as a thrown library error.

### 12.4 `RailAggregateError` shape

`RailAggregateError` is the library's container for multi-error aggregates. It is produced exclusively by `parallel(...)` when one or more branches propagate `RailError` or a nested `RailAggregateError`. Additional codes are a future option.

```js
class RailAggregateError extends RailError {
  name = 'RailAggregateError';
  code: string;                       // 'PARALLEL_BRANCH_FAILED' is the only current code
  flowName: string;                   // top-level flow name
  branchErrors: { [branchName: string]: RailError | RailAggregateError };
  errors: (RailError | RailAggregateError)[];  // convenience array view of branchErrors values
}
```

**Construction.** Throw-sites construct the aggregate with a `branchErrors` object — `new RailAggregateError(branchErrors)`. The constructor sets `code` to `'PARALLEL_BRANCH_FAILED'`, stores `branchErrors`, derives `errors` as `Object.values(branchErrors)` for convenience, and composes the standard `message` as `"<N> branch(es) failed: <branchName1>, <branchName2>, …"`. The keyed `branchErrors` is the source of truth for which branch failed with which error; `errors` is the array view that callers can iterate without knowing branch names.

`flowName` is **not** a constructor argument — it is set by `flow.run`'s classification boundary (§9) before the aggregate escapes to the user, mirroring the convention for `RailRuntimeError`.

`branchErrors` contains **only** the rejected branches, keyed by branch name in declaration order. Fulfilled branches' ctxes are discarded when the aggregate is constructed (see §8 — Result collection) and are not represented in the aggregate. `Object.keys(branchErrors).length` is therefore the number of failed branches, not the total branch count.

`RailAggregateError` extends `RailError`, so `err instanceof RailError` is the single membership test for any library-produced error. The aggregate is **not** a `native AggregateError` subclass — callers that need to integrate with code expecting `instanceof AggregateError` should test `err instanceof RailError && Array.isArray(err.errors)` instead.

Like `RailRuntimeError`, the aggregate does not carry the run trace or the ctx — see §12.3.

Codes:

| Code                       | When                                                                                                         |
|----------------------------|--------------------------------------------------------------------------------------------------------------|
| `PARALLEL_BRANCH_FAILED`   | One or more branches of a `parallel(...)` node failed.                                                       |

The standard `message` constructed by the top-level runner is `"<N> branch(es) failed: <branchName1>, <branchName2>, …"`.

---

## 13. Runtime semantics

### 13.1 Initial state and run-state

`flow.run(initialCtx, opts)`:

- `initialCtx` defaults to `{}` when omitted or `undefined`. The library does not clone the supplied ctx; user functions mutate it in place during the run (§2.2 "Mutation model"). The same reference appears as `result.ctx` in the `RunResult`. Callers that need isolation from later mutations should pass a clone.
- `opts.logger` — `(entry: TraceEntry) => void`. Default: the built-in console logger (§13.6). Called once per step after it finishes.
- `opts.loggerErrorPolicy` — `'throw' | 'swallow'`, default `'throw'`.
- `opts.tracer` — `(entry: TraceEntry, event: 'begin' | 'end') => void`. Two events per successfully completed node invocation (§13.6). Default: no tracer.
- `opts.tracerErrorPolicy` — `'throw' | 'swallow'`, default `'swallow'`.
- `opts.maxSteps` — run-global step limit. Default `1000`. Checked against `runState.trace.length` after each push.
- `opts.signal` — optional `AbortSignal` for cooperative cancellation. Steps see it via `runInfo.signal` (combined with `opts.killSignal` and the internal abort controller, §13.4).
- `opts.killSignal` — optional `AbortSignal` for the kill switch. The runner checks it before each node; if aborted, the run rejects with `RailRuntimeError(KILLED)`.

From these options, `run` constructs a **runState**:

```js
runState = {
  trace:        TraceEntry[],     // initially []
  maxSteps:     number,
  flowName:     string,            // top-level flow name (immutable)
  tracer:       ((entry, event) => void) | undefined,
  logger:       (entry) => void,
  tracerErrorPolicy: 'swallow' | 'throw',
  loggerErrorPolicy: 'swallow' | 'throw',
  killSignal:    AbortSignal | undefined,   // raw caller signal
  combinedSignal: AbortSignal,              // signal + killSignal + internal abort
  internalAbortController: AbortController, // library-driven aborts (e.g. Parallel branch failure)
}
```

`runState` is the same object reference throughout a run. Implementations do not fork or replace it; sub-activities and parallel branches receive the same reference all the way down. `trace` and per-position `local` slots are mutated in place.

### 13.2 Step execution

Step execution is implemented by `invokeNode` (§2.2) and the kind-specific `doInvoke` closures. The numbered nine-step sequence — cycle-counter increment, TraceEntry construction and push, step-budget check, kill check, tracer `'begin'`, `doInvoke` delegation, success completion (`exit`/`endTime`, tracer `'end'`, logger), or throw propagation — is given authoritatively in §2.2's code listing.

Two boundary points worth restating in the runtime context:

- The logger is invoked **after** the tracer at the `'end'` point. Run-level events do not exist — the logger and tracer both work at the per-node level.
- A step is **failed** if and only if `doInvoke` threw — that is, the step's `_invoke` did not return normally. A failed step leaves its TraceEntry in `runState.trace` with `endTime` and `exit` unset; the library emits neither the `'end'` tracer event nor the logger call for it, and the throw propagates out of `invokeNode` and terminates the run. Subsequent throws inside the tracer `'end'` or the logger itself (under `'throw'` policy) are *not* "failed step" events — they are user-callback failures that propagate after the step has already been recorded as ended; their `endTime`/`exit` are filled.

#### Atomic node execution

Atomic builders' `doInvoke` (§3):

- Construct `runInfo` from `traceEntry` and `runState` fields:
  ```js
  const runInfo = {
    signal:     runState.combinedSignal,
    flowName:   runState.flowName,
    traceEntry,
  };
  ```
- Call `await fn(ctx, local, runInfo)`.
- Apply the builder's exit-selection rules (§3).
- Validate the chosen `exit` is in `node.outputs`. If not, raise `RailRuntimeError(UNKNOWN_OUTPUT_AT_RUNTIME)` with a message naming the returned value and the valid outputs — e.g. `"node 'validate' returned 'maybe'; expected one of: success, failure"`.
- Return the exit string to `invokeNode`.

#### Activity execution

Activity's `doInvoke` (§15.7) walks the wire graph from the chosen entry to whichever exit is reached, invoking each sub-node via `subNode._invoke(...)`. Each sub-invocation goes through its own `invokeNode` and contributes one entry to `runState.trace`. The Activity itself contributes one outer entry — the one `invokeNode` pushed before delegating to `doInvoke`.

#### Parallel execution

Parallel's `doInvoke` (§8) runs all branches via `Promise.allSettled`, each receiving a `local` slot from `local.branches[branchName]` and a `path` extended with the branch name. Branch interleaving is non-deterministic; the resulting trace entries appear in the order their respective `invokeNode` pushed them. `runState.trace` is shared across all branches. If a merge node is configured and all branches resolved, the merge runs after `allSettled` returns, with its own `local._merge` slot and a path extended by `'__merge__'`. The merge entry appears in the trace after the last branch entry.

### 13.3 Behaviour when a node throws

When a node throws (or the returned Promise rejects), the value is classified per §2.1:

1. **`RailError`** — propagates unchanged.
2. **`RailAggregateError`** — propagates unchanged.
3. **Anything else** — wrapped into `RailRuntimeError(UNHANDLED_THROW)` with the original error as `cause`, either by `parallel` (per rejected branch, before the aggregate is constructed) or by `flow.run` at the top-level boundary.

`activity.doInvoke` performs no wrapping — it re-throws unchanged so the wrap happens once at the relevant boundary.

A `TraceEntry` is appended for the throwing position when `invokeNode` pushes it; on throw, the entry remains with `endTime` and `exit` undefined. This unfilled entry is the last in the trace before propagation and marks where the run died.

### 13.4 Cancellation: `signal` and `killSignal`

The library supports two cancellation mechanisms.

#### Cooperative cancellation (`opts.signal`)

The caller passes an `AbortSignal` as `opts.signal`. The runner exposes it to step implementations as `runInfo.signal`, which combines `opts.signal`, `opts.killSignal`, and the internal abort controller (see "Linking" below). Steps decide how to react — typically by passing it to abortable I/O or polling it between sub-operations. See §14.10 for examples.

#### Kill switch (`opts.killSignal`)

The caller passes an `AbortSignal` as `opts.killSignal`. `invokeNode` observes it directly (§2.2 step 5): before delegating to `doInvoke`, it checks `killSignal.aborted`; if true, the run rejects with `RailRuntimeError(KILLED)`.

The library makes no attempt to interrupt a step that is already running. The guarantee is: once `killSignal` has aborted, no further node will be started.

#### Linking `signal`, `killSignal`, and internal aborts

The runner constructs `runState.combinedSignal` — delivered to user functions as `runInfo.signal` — by combining three sources:

- `opts.signal` — cooperative cancellation;
- `opts.killSignal` — kill switch;
- the library's internal abort controller — used by `parallel(...)` to signal sibling branches when one branch fails (§8).

The combined signal aborts as soon as any of the three does. `invokeNode` observes the raw `killSignal` for its kill check — only a caller-initiated kill aborts the run with `RailRuntimeError(KILLED)`. An internal abort from a sibling branch is not a kill; it lets siblings exit cooperatively while the Parallel-Node collects rejections and throws a `RailAggregateError`.

| Caller passes               | `runInfo.signal` is                                              | invokeNode kill-checks |
|-----------------------------|------------------------------------------------------------------|------------------------|
| neither                     | a derived signal that aborts only on the library's internal abort | no                     |
| `signal` only               | a derived signal that aborts when `signal` or internal aborts    | no                     |
| `killSignal` only           | a derived signal that aborts when `killSignal` or internal aborts | yes                    |
| both                        | a derived signal that aborts when any of the three aborts        | yes                    |

If the caller passes the same `AbortSignal` for both `opts.signal` and `opts.killSignal`, the library treats this as the "both" row; no de-duplication is performed.

Because `runState` is the same reference throughout a run, sub-activities and parallel branches see the outer's signals as their own.

### 13.5 Step budget (`maxSteps`)

`runState.maxSteps` (default `1000`) is the run-global step limit. `invokeNode` checks `runState.trace.length` after each push; if it exceeds `maxSteps`, `RailRuntimeError(STEP_BUDGET_EXCEEDED)` is thrown and the run terminates.

The push happens before the check, so a run with `maxSteps = N` allows exactly `N` nodes to be pushed before the next push fails. After a `STEP_BUDGET_EXCEEDED` throw, `runState.trace.length` reads `N + 1` (the failed attempt is included).

`maxSteps` is run-global across sub-activities and parallel branches; every node executed counts against the same counter.

### 13.6 Logger and tracer

The default logger writes one line per successfully completed step to `console.log`, prefixed with `runState.flowName`. Indentation is `entry.path.length * 2` spaces — the Flow's held top-level node (path `[]`) has zero indentation, its direct sub-nodes have two spaces, and so on. The label per line is `entry.path.join('.')`; for the top-level entry (`path === []`), `join` produces the empty string, so the logger substitutes the flow name. This results in the top-level line repeating the flow name (once as prefix, once as label) — that is intentional and keeps the format uniform: every line has both `[flowName]` prefix and a path-derived label. When `entry.cycle > 1`, the line is suffixed with ` #N` where `N` is the cycle count:

```
[sendMessage]   validate           (0.07ms) -> success
[sendMessage]   retry              (32.29ms) -> ok
[sendMessage]     op               (12.04ms) -> retry
[sendMessage]     op               (15.42ms) -> retry #2
[sendMessage]     op               (14.83ms) -> ok #3
[sendMessage]   encrypt            (3.21ms) -> success
[sendMessage]     inner.encrypt    (2.15ms) -> success
[sendMessage]     inner.send       (8.41ms) -> success
[sendMessage]   inner              (10.62ms) -> success
[sendMessage] sendMessage          (74.21ms) -> success
```

The last line is the top-level entry (`path === []`), labelled with the flow name and with zero indentation. It always appears once per successful run, after all sub-nodes have completed.

The logger is invoked once per successfully completed step (after the tracer's `'end'` event). Steps that ended in a library throw produce **no logger output** — they have no `'end'` event. Their TraceEntry remains in the trace with `endTime`/`exit` unset; a tracer or post-mortem inspector that walks the trace can detect them by the missing `endTime`. The thrown error itself is delivered to the `flow.run(...)` caller as a regular JavaScript throw, with `e.flowName`, `e.code`, `e.message`, and (when applicable) `e.cause`.

A custom logger may be passed via `opts.logger`. Its throw behaviour is controlled by `opts.loggerErrorPolicy` (`'throw' | 'swallow'`, default `'throw'`):

- **`'throw'`** (default): the exception propagates out of `flow.run(...)` and terminates the run like any other throw out of `_invoke`.
- **`'swallow'`**: the exception is caught internally; the run continues. The logger has no fallback channel; a swallowed throw is silently dropped.

The tracer (`opts.tracer`) is invoked at two points per node invocation, with the signature:

```js
tracer(entry: TraceEntry, event: 'begin' | 'end')
```

- **`'begin'`** — fired after `invokeNode` has pushed the entry and passed the step-budget and kill checks. The entry has `path`, `kind`, `cycle`, `entry`, `ctx`, `local`, and `startTime` populated; `endTime` and `exit` are still `undefined`.
- **`'end'`** — fired after a successful `doInvoke` return. The same entry now has `exit` and `endTime` populated.

A clean run pairs every `'begin'` with exactly one `'end'`. If `doInvoke` throws, the entry remains in the trace with only `startTime` set (no `'end'` follows), and the throw propagates — the run is over. Wrappers (`pin`) are trace-transparent (§2) and emit nothing.

**Pairing in parallel sections.** A `parallel(...)` invocation produces its own `'begin'`/`'end'` pair (because the Parallel node itself runs through `invokeNode`, §2.2), within which branch and merge events nest:

```
parallel:'begin'
  ← branch events interleave concurrently here →
  (each branch produces one 'begin' and one 'end' in declaration-independent order)
  ← all branches have ended by this point (Promise.allSettled) →
  merge:'begin'         (only if a merge node is configured and all branches resolved)
  merge:'end'
parallel:'end'
```

Structural guarantees:

- Every branch's `'begin'` and `'end'` falls strictly between the parallel's `'begin'` and `'end'`.
- Branches execute concurrently; their events interleave arbitrarily. A consumer cannot assume `branch_i:'begin'` precedes `branch_{i+1}:'begin'`, nor that all `'begin'`s precede all `'end'`s — a fast branch may complete (`'end'`) before a slower sibling has started its async work.
- The merge node's events (if configured) come strictly after every branch's `'end'` and strictly before the parallel's `'end'`. The merge runs only when all branches resolved; on any rejection, the parallel throws `RailAggregateError` without invoking the merge, so neither `merge:'begin'` nor `merge:'end'` is emitted.

The pairing rule ("every `'begin'` matched by at most one `'end'`") holds per TraceEntry identity, not by adjacency: between a branch's `'begin'` and its `'end'`, sibling branches may emit any number of their own `'begin'`/`'end'` events. Tracer consumers that need to reconstruct per-branch sequences must group by entry identity (e.g. via `path`). The merge entry's `path` ends with `'__merge__'` (§8); branches' paths end with their branch names.

The tracer's throw behaviour is controlled by `opts.tracerErrorPolicy` (`'throw' | 'swallow'`, default `'swallow'`):

- **`'swallow'`** (default): the exception is caught internally; the run continues. The swallowed exception is silently dropped.
- **`'throw'`**: the exception propagates out of `flow.run(...)` and terminates the run like any other throw out of `_invoke`.

**Why the defaults differ.** The logger defaults to `'throw'` because the default logger is library-controlled and known-safe; a custom logger that throws indicates a bug the caller wants surfaced. The tracer defaults to `'swallow'` because tracers are user-supplied diagnostic plumbing (telemetry sinks, replay buffers, WebSocket forwarders) whose failure should not derail an otherwise-correct run. Callers that *want* tracer failures to be fatal — e.g. tests that assert tracer correctness — set `tracerErrorPolicy: 'throw'` explicitly.

#### Tracer contract

- The tracer is called synchronously. The library does not `await` its return value. Tracers that need to deliver events asynchronously must buffer internally.
- The tracer must not mutate the entry or any value reachable through it. The library mutates the entry in place between `'begin'` and `'end'`; tracers that retain entries for later use must clone them at receipt.
- The tracer may start new flow runs during event handling. Each new run allocates its own `runState` independently.

---

## 14. Examples

The examples below are intended to be readable in isolation, but they share the import line and any helpers introduced earlier in the section.

```js
import {
  activity, flow, atom, nstep, step, pass, fail, catchTo,
  pin, parallel, nrail, railway, isRailNode,
  RailError,
} from './rail.js';
```

### 14.1 Minimal happy-path

A single-step activity that validates an input and exits.

```js
const validateEmail = atom(async (ctx) => {
  if (typeof ctx.email === 'string' && ctx.email.includes('@')) {
    return 'ok';
  }
  ctx.reason = 'invalid email';
  return 'bad';
}, { outputs: ['ok', 'bad'] });

const validateOnly = activity((a) => {
  a.entry('in');
  a.addNode('check', validateEmail);
  a.exit('success');
  a.exit('failure');

  a.wire('.in',         'check.in');
  a.wire('check.ok',    '.success');
  a.wire('check.bad',   '.failure');
});

const f = flow('validate-only', validateOnly);
const r = await f.run({ email: 'me@example.com' });
// r === { exit: 'success',
//         ctx: { email: 'me@example.com' },
//         trace: [...] }
```

### 14.2 Routing exceptions to multiple outputs

Catch exceptions of different classes and route each to a dedicated output. The classification is plain user-function code; the library does not provide a wrapper for this — `catchTo` (§11) handles single-exit routing, anything more nuanced is written directly.

```js
class NetworkError extends Error {}
class AuthError extends Error {}

const sendWithRouting = atom(async (ctx, local, runInfo) => {
  try {
    await transmit(ctx.payload, { signal: runInfo.signal });
    return 'ok';
  } catch (err) {
    if (err instanceof RailError) throw err;
    ctx._error = err;
    if (err instanceof NetworkError) return 'retry';
    if (err instanceof AuthError)    return 'denied';
    return 'fatal';
  }
}, { outputs: ['ok', 'retry', 'denied', 'fatal'] });

const a = activity((a) => {
  a.entry('in');
  a.addNode('send', sendWithRouting);
  a.addNode('report', pass(async (ctx) => {
    if (ctx._error) {
      console.log('reporting:', ctx._error.message);
    }
  }));
  a.exit('sent');
  a.exit('retried');
  a.exit('denied');
  a.exit('failed');

  a.wire('.in',             'send.in');
  a.wire('send.ok',         '.sent');
  a.wire('send.retry',      'report.success');
  a.wire('report.success',  '.retried');
  a.wire('send.denied',     '.denied');
  a.wire('send.fatal',      '.failed');
});
```

`ctx._error` carries the original exception to downstream nodes (§10.2); the classification logic is visible at the use site. `RailError` and `RailAggregateError` must always be re-thrown — they signal contract violations and terminate the run.

### 14.3 Sub-activity composition

A reusable validation activity, used twice in the same parent under different local names.

```js
const validate = activity((a) => {
  a.entry('in');
  a.addNode('check', atom(async (ctx) => {
    if (ctx.value != null) return 'ok';
    ctx.reason = 'missing';
    return 'bad';
  }, { outputs: ['ok', 'bad'] }));
  a.exit('ok');
  a.exit('bad');
  a.wire('.in',       'check.in');
  a.wire('check.ok',  '.ok');
  a.wire('check.bad', '.bad');
});

const twoStage = activity((a) => {
  a.entry('in');
  a.addNode('v1', validate);  // first use
  a.addNode('v2', validate);  // second use, same instance
  a.exit('done');
  a.exit('rejected');
  a.wire('.in',     'v1.in');
  a.wire('v1.ok',   'v2.in');
  a.wire('v1.bad',  '.rejected');
  a.wire('v2.ok',   '.done');
  a.wire('v2.bad',  '.rejected');
});
```

The same `validate` instance is added twice; per §5.5 it is walked once during the outer activity's validation (identity-based memoisation, §5.6).

### 14.4 Build error

`activity(...)` validates the assembled graph at the end of the builder (§5.6). Build mistakes surface as `RailBuildError` from inside the `activity(...)` call.

```js
try {
  const broken = activity((a) => {
    a.entry('success');
    a.addNode('work', step(async () => {}));
    a.exit('done');
    a.wire('.success', 'work.success');
    // forgot: a.wire('work.success', '.done');
    // forgot: a.wire('work.failure', ???);
  });
} catch (err) {
  if (err instanceof RailError) {
    console.log(err.code);   // 'UNUSED_PORT'
    console.log(err.message); // mentions 'work.success' / 'work.failure'
  }
}
```

Custom-kind authors who construct node values by hand (without going through a built-in builder) are responsible for ensuring their nodes satisfy the structural and `_invoke` requirements; the library does not provide a validation method that custom-kind code can call. See §2.

### 14.5 `parallel` with merge node

Run two independent enrichment branches and consolidate their results into a domain-shaped ctx. Each branch receives a shallow copy of the incoming ctx, so `userId` is available in both. The merge node, given to `parallel(...)` as its second argument, receives the aggregated `{ profile, orders }` ctx and replaces it with the final ctx the caller wants.

```js
const fetchProfile = step(async (ctx) => {
  ctx.profile = await fakeFetch('/profile/' + ctx.userId);
});

const fetchOrders = step(async (ctx) => {
  ctx.orders = await fakeFetch('/orders/' + ctx.userId);
});

const mergeResults = atom(async (ctx) => {
  // Aggregated ctx is { profile: <branch-ctx>, orders: <branch-ctx> }.
  // Either branch carries the pre-parallel userId via its shallow copy.
  const userId  = ctx.profile.userId;
  const profile = ctx.profile.profile;
  const orders  = ctx.orders.orders;
  // Replace ctx in place with the merged shape.
  for (const k of Object.keys(ctx)) delete ctx[k];
  ctx.userId  = userId;
  ctx.profile = profile;
  ctx.orders  = orders;
  return 'out';
}, { outputs: ['out'] });

const enrichBoth = parallel({
  profile: fetchProfile,
  orders:  fetchOrders,
}, mergeResults);

// enrichBoth.outputs === ['out'] — the merge node's outputs.
// enrichBoth.inputs  === ['in']  — Parallel's fixed single input.
```

The parallel composite now exposes a single `'out'` exit (from the merge), and the activity wiring it in only needs `'enrichBoth.out'` to consume the post-merge ctx. If the merge had declared `outputs: ['success', 'failure']`, the composite would expose those two outputs instead, and the activity could wire to `'enrichBoth.success'` and `'enrichBoth.failure'` independently — letting `parallel(...)` discriminate outcomes without a separate downstream step.

Without a merge node, the same effect requires a separate `merge` sub-node in the surrounding activity wired explicitly from `par.out` (see §8 — the merge node is functionally equivalent to that pattern, but structurally encapsulated within the parallel).

### 14.6 Routing multiple steps' throws to one reporter

Two steps, each catching their own exception class with `catchTo`, both routed to a single reporter that distinguishes by inspecting `ctx._error`.

```js
class StepAError extends Error {}
class StepBError extends Error {}

const stepA = nstep(catchTo(async () => {
  throw new StepAError('A failed');
}, 'failed'), 'in', ['ok', 'failed']);

const stepB = nstep(catchTo(async () => {
  throw new StepBError('B failed');
}, 'failed'), 'in', ['ok', 'failed']);

const a = activity((a) => {
  a.entry('in');
  a.addNode('a', stepA);
  a.addNode('b', stepB);
  a.addNode('report', pass(async (ctx) => {
    if (ctx._error) {
      console.warn(`error from ${ctx._error.constructor.name}: ${ctx._error.message}`);
    }
    ctx.ok = false;
  }));
  a.exit('done');

  a.wire('.in',             'a.in');
  a.wire('a.ok',            'b.in');
  a.wire('a.failed',        'report.success');
  a.wire('b.ok',            '.done');
  a.wire('b.failed',        'report.success');
  a.wire('report.success',  '.done');
});
```

### 14.7 Top-level atomic node

`flow(name, node)` accepts any Rail-Node with exactly one input, so an atomic node can be used directly:

```js
const greet = atom(async (ctx) => {
  const msg = `hi ${ctx.name}`;
  // Replace ctx in place: just the msg field, no name.
  for (const k of Object.keys(ctx)) delete ctx[k];
  ctx.msg = msg;
  return 'out';
}, { outputs: ['out'] });

const f = flow('greet', greet);
const r = await f.run({ name: 'Mat' });
// r.exit === 'out'
// r.ctx === { msg: 'hi Mat' }
```

`step`, `pass`, `fail` are equally usable as top-level nodes — they have a single input (`'success'` for `step`/`pass`, `'failure'` for `fail`).

### 14.8 Reusing a node under multiple names

A single atomic-builder instance, used as two distinct positions:

```js
const log = pass(async (ctx, _local, runInfo) => {
  console.log(runInfo.traceEntry.path.join('.'), ctx);
});

const logged = activity((a) => {
  a.entry('in');
  a.addNode('logIn',  log);  // same instance
  a.addNode('logOut', log);  // ...used under two local names
  a.addNode('process', step(async (ctx) => { ctx.processed = true; }));
  a.exit('done');

  a.wire('.in',              'logIn.success');
  a.wire('logIn.success',    'process.success');
  a.wire('process.success',  'logOut.success');
  a.wire('process.failure',  '.done');
  a.wire('logOut.success',   '.done');
});
```

`runInfo.traceEntry.path` distinguishes the two invocations: `['logIn']` vs. `['logOut']`.

### 14.9 Library throw vs domain outcome

Two paths exit a node. A library throw — an unhandled exception out of an `atom` — propagates out of `flow.run(...)` as a `RailError` (no `RunResult`). A domain outcome — a `step` that caught its exception and routed it to `'failure'` — terminates the run at an exit and produces a normal `RunResult` with `exit === 'failure'`.

```js
const distinguish = activity((a) => {
  a.entry('in');
  a.addNode('check', step(async (ctx) => {
    if (ctx.value < 0) throw new Error('panic');   // routed to failure
    if (ctx.value === 0) throw new Error('zero'); // routed to failure
  }));
  a.exit('success');
  a.exit('failure');

  a.wire('.in',             'check.success');
  a.wire('check.success',   '.success');
  a.wire('check.failure',   '.failure');
});

const f = flow('distinguish', distinguish);

console.log((await f.run({ value: 1 })).exit);     // 'success'
console.log((await f.run({ value: 0 })).exit);     // 'failure'
console.log((await f.run({ value: -1 })).ctx._error?.message);  // 'panic'
```

`step` (§3.3) catches user-function throws and routes them to `'failure'` with `ctx._error` set to the thrown error (§10.2). To let an exception propagate out of `flow.run(...)` instead, use `atom` directly — with no `catchTo` wrapper, throws out of the user function become library throws.

### 14.10 Cooperative cancellation

Two abort channels are available (§13.4):

- `opts.signal` — **cooperative.** The signal is exposed as `runInfo.signal`; nodes that consult it can exit gracefully. The library does not enforce cancellation: if no node reacts, the run completes normally.
- `opts.killSignal` — **enforcing.** `invokeNode` checks `killSignal?.aborted` before every node and throws `RailRuntimeError(KILLED)` immediately when it fires.

The two are typically combined: a `signal` lets the running node finish its cleanup; a `killSignal` is the hard stop.

**Cooperative pattern with `signal`.** The node observes the signal and routes to `failure` cooperatively. The run completes at an exit; the caller inspects `result.ctx._error`:

```js
const longRunner = step(async (ctx, _local, runInfo) => {
  for (let i = 0; i < 1_000_000; i++) {
    if (runInfo.signal.aborted) {
      throw new DOMException('aborted', 'AbortError');
    }
    await new Promise((r) => setTimeout(r, 1));
  }
});

const cancellable = activity((a) => {
  a.entry('in');
  a.addNode('long', longRunner);
  a.exit('done');
  a.exit('aborted');
  a.wire('.in',           'long.success');
  a.wire('long.success',  '.done');
  a.wire('long.failure',  '.aborted');
});

const f = flow('cancellable', cancellable);
const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), 100);

const result = await f.run({}, { signal: ctrl.signal });
console.log(result.exit);                        // 'aborted'
console.log(result.ctx._error?.name);            // 'AbortError'
```

`step` catches the `AbortError` thrown by `longRunner` and routes to `failure` with `ctx._error` set; the activity then wires `failure` to the `.aborted` exit. The run completes at an exit, no library error is thrown.

**Enforcing pattern with `killSignal`.** The library aborts at the next node boundary regardless of whether nodes consult `signal`. The caller receives a thrown `RailRuntimeError(KILLED)`:

```js
const f = flow('cancellable', cancellable);
const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), 100);

try {
  await f.run({}, { killSignal: ctrl.signal });
} catch (err) {
  console.log(err.name);   // 'RailRuntimeError'
  console.log(err.code);   // 'KILLED'
}
```

`runInfo.signal` is the **combined** signal (§13.4) — it aborts whether the caller's `signal`, the caller's `killSignal`, or the library's internal abort triggers.

### 14.11 Custom logger

```js
const f = flow('myflow', node);
await f.run(ctx, {
  logger: (entry) => {
    const path = entry.path.join('.');
    console.log(`${path} -> ${entry.exit}`);
  },
});
```

The logger contract is described in §13.6 (signature, error policy). Each `run` call may use a different logger; callers that want a shared logger across runs wrap `flow.run` themselves. The logger is only invoked for successfully completed steps; library errors are delivered as ordinary JavaScript throws from `flow.run`.

### 14.12 Live tracer for a web UI

A tracer that pushes events through a WebSocket. Each event arrives with the current `TraceEntry` and the event kind (`'begin' | 'end'`); the consumer reconstructs the run timeline.

```js
const f = flow('myflow', node);
await f.run(ctx, {
  tracer: (entry, event) => {
    socket.send(JSON.stringify({
      event,
      path: entry.path,
      kind: entry.kind,
      cycle: entry.cycle,
      // shallow copies were taken at push time;
      // safe to read without cloning further:
      ctxAtEntry: entry.ctx,
      ...(event === 'end' ? {
        endTime: entry.endTime,
        exit:    entry.exit,
      } : {}),
    }));
  },
});
```

Tracers run synchronously and must not mutate the entry (§13.6). For high-frequency runs, buffer locally and flush.

### 14.13 Retry pattern with `local`

A retrying step that uses its `local` for the attempt counter. The position's `local` persists across cycles within a single `flow.run(...)` (§2.3), so the counter accumulates correctly; a new run starts with a fresh empty `local`.

```js
const fetchWithRetry = atom(async (ctx, local) => {
  local.attempts ??= 0;
  local.attempts++;
  try {
    ctx.data = await fakeFetch(ctx.url);
    return 'ok';
  } catch (err) {
    if (err instanceof RailError) throw err;
    if (local.attempts < 3) return 'retry';
    ctx.lastError = err.message;
    return 'giveUp';
  }
}, { outputs: ['ok', 'retry', 'giveUp'] });

const retrier = activity((a) => {
  a.entry('in');
  a.addNode('fetch', fetchWithRetry);
  a.exit('done');
  a.exit('failed');
  a.wire('.in',           'fetch.in');
  a.wire('fetch.ok',      '.done');
  a.wire('fetch.retry',   'fetch.in');     // loop back
  a.wire('fetch.giveUp',  '.failed');
});
```

The cycle counter on `fetch` (visible as `traceEntry.cycle` for each invocation) increments with each pass through the loop. The step budget (§13.5) backstops runaway loops.

### 14.14 `nrail` builder

The `nrail` builder (§6) creates an Activity with `n` parallel outcome tracks. Steps consume named rails as inputs and produce named rails as outputs; the builder wires them via the Live-Set. Throws propagate by default; `catchTo` (§11) provides opt-in throw-to-exit routing.

```js
import { nrail, catchTo, flow } from './rail.js';

const orderPipeline = nrail((r) => {
  r.entry('main');
  r.step('validate',
    catchTo(async (ctx) => {
      if (!ctx.orderId) throw new Error('missing orderId');
    }, 'fail'),
    'main', ['main', 'fail']);
  r.step('charge',
    catchTo(async (ctx) => {
      ctx.tx = await fakeCharge(ctx);
    }, 'retry'),
    'main', ['main', 'retry', 'fail']);
  r.step('logRetry', async (ctx) => {
    console.warn('retrying:', ctx._error?.message);
  }, 'retry', 'fail');
  r.step('cleanup', async (ctx) => {
    await fakeRollback(ctx);
  }, 'fail', 'fail');
});

const f = flow('order-pipeline', orderPipeline);
const result = await f.run({ orderId: '42' });
// result.exit ∈ { 'main', 'fail' }
```

Three rails: `main` (success path), `retry` (recoverable failures rerouted to logging), `fail` (hard failures with cleanup). The `cleanup` step converges the `fail` outputs of `validate`, `charge`, and `logRetry` (per-rail convergence at `cleanup.fail`). The final exits are `main` (for `charge.main`) and `fail` (for `cleanup.fail`).

### 14.15 `railway` builder

The railway builder (§7) is a thin wrapper over `nrail` (§6) for two-track success/failure flows.

```js
const orderPipeline = railway((r) => {
  r.step('validate', async (ctx) => {
    if (!ctx.orderId) throw new Error('missing orderId');
  });
  r.step('charge', async (ctx) => {
    ctx.tx = await fakeCharge(ctx);
  });
  r.pass('confirm', async (ctx) => {
    await fakeSendEmail(ctx);
  });
});

const f = flow('order-pipeline', orderPipeline);
const result = await f.run({ orderId: '42' });
```

The exits are the standard `success` and `failure`. Any thrown exception is caught and routed to the failure track, with `ctx._error` carrying the underlying error.

---

## 15. Implementation notes

These notes are non-normative guidance for an implementor. The spec itself is the contract; the notes are how to satisfy it efficiently.

### 15.1 Wire storage

Wires are declared as strings (§5.2). Internally they should be stored on the **activity** in a forward-lookup-friendly form. A simple shape:

```js
// activity._wires :: Map<sourceEndpointKey, targetEndpointKey>
// sourceEndpointKey === '<subName>.<outputName>' or '.<entryName>' for activity entry
// targetEndpointKey === '<subName>.<inputName>'  or '.<exitName>'  for activity exit
```

`Map<string, string>` is sufficient for forward traversal because of the single-source invariant (§5.3): every activity entry and every sub-node output has at most one outgoing wire. Target endpoints (sub-node inputs, activity exits) may have multiple incoming wires (convergence is supported); the forward-only map captures the unique outgoing relationship that the graph walk needs.

For renderers (Mermaid, §2.4) that want incoming-wire lists per target, a transient reverse index is built on demand and discarded.

### 15.2 Run state shape

The runtime carries a single `runState` object through the whole run (§13.1). Suggested shape:

```js
{
  trace: TraceEntry[],
  maxSteps: number,
  flowName: string,
  tracer: ((entry, event) => void) | undefined,
  logger: (entry) => void,
  tracerErrorPolicy: 'throw' | 'swallow',
  loggerErrorPolicy: 'throw' | 'swallow',
  killSignal: AbortSignal | undefined,
  combinedSignal: AbortSignal,
  internalAbortController: AbortController,
}
```

`internalAbortController` produces the abort the runtime itself triggers (e.g. when a parallel branch errors, §8). `combinedSignal` is the signal exposed via `runInfo.signal` (§13.4); it fires on any of the three sources — caller's `opts.signal`, caller's `opts.killSignal`, or the internal controller.

A run-state factory function builds this from `flow.run(ctx, opts)`:

```js
function makeRunState(flow, opts) {
  const internal = new AbortController();
  const signals = [];
  if (opts?.signal)     signals.push(opts.signal);
  if (opts?.killSignal) signals.push(opts.killSignal);
  signals.push(internal.signal);
  const combined = signals.length === 1
    ? signals[0]
    : AbortSignal.any(signals);

  return {
    trace: [],
    maxSteps: opts?.maxSteps ?? 1000,
    flowName: flow.name,
    tracer: opts?.tracer,
    logger: opts?.logger ?? defaultConsoleLogger,
    tracerErrorPolicy: opts?.tracerErrorPolicy ?? 'swallow',
    loggerErrorPolicy: opts?.loggerErrorPolicy ?? 'throw',
    killSignal: opts?.killSignal,
    combinedSignal: combined,
    internalAbortController: internal,
  };
}
```

`combinedSignal` aborts on any of: the caller's `opts.signal`, the caller's `opts.killSignal`, or the library's `internalAbortController` (the latter is what `parallel(...)` triggers when a branch fails, so sibling branches see `runInfo.signal.aborted` and can exit cooperatively, §8). Steps read this combined signal as `runInfo.signal`.

`runState.killSignal` is the **raw caller signal**, kept separate. `invokeNode` consults it (not the combined signal) for the kill check: only a caller-initiated abort aborts the run with `RailRuntimeError(KILLED)`. An internal abort from a sibling branch in Parallel propagates only via the combined signal — it lets the running steps in sibling branches cooperatively exit, but does not itself constitute a "kill" of the whole run.

**Note on `AbortSignal.any`.** The sketch above uses `AbortSignal.any(...)` for combining the source signals. This is available in Node ≥ 19 and in modern browsers (since Q3 2023). Runtimes that lack it — notably embedded engines such as QuickJS, where `AbortController`/`AbortSignal` are themselves not part of the standard library and must be host-provided — can implement the same observable behaviour with a fresh `AbortController` whose `abort()` is called from a one-shot listener on each source signal. The observable contract is "the combined signal aborts as soon as any source signal aborts"; the mechanism is the implementer's choice.

The defaults come from the library: `maxSteps: 1000`, `tracerErrorPolicy: 'swallow'`, `loggerErrorPolicy: 'throw'`, `logger: defaultConsoleLogger` (the built-in console logger described in §13.6), `tracer: undefined` (no-op). See §13 for the field semantics. To suppress the default logger, callers pass `opts.logger: () => {}` or any other no-op function.

### 15.3 `invokeNode` central plumbing

`invokeNode(doInvoke, kind, entry, ctx, local, runState, path)` is the shared framing helper around any node body. The authoritative nine-step sequence is in §2.2's code listing.

Implementation notes on top of that listing:

- `invokeNode` consults `runState.killSignal` (the raw caller signal), not `runState.combinedSignal`, for the kill check. Internal aborts from sibling branches in a parallel section reach user code via the combined signal but do not trigger `RailRuntimeError(KILLED)`.
- The `entryRec` is passed to `doInvoke` as a trailing argument so atomic-builder `doInvoke` implementations can expose it via `runInfo.traceEntry` (§11). Group builders ignore it.
- `invokeNode` is exposed via the public API (§2) so that custom node kinds can adopt the same framing. Wrappers (`pin`) are trace-transparent (§2) and do not call `invokeNode`.

### 15.4 Atomic builders

`atom` is the primitive. Its `doInvoke` invokes the user function and validates the returned `exit` against the node's declared `outputs`; an unknown exit raises `RailRuntimeError(UNKNOWN_OUTPUT_AT_RUNTIME)`. Thrown exceptions propagate untouched per §2.1.

`nstep(fn, inputs, outputs)` is a convenience over `atom` (§3.2): it normalises string-or-array `inputs` and `outputs` to arrays and, for single-output, wraps `fn` so that a nullish return value (`undefined` or `null`) resolves to the single declared output. Explicit string returns are forwarded to `atom` unchanged for validation against `outputs`.

`step`, `pass`, `fail` are factory functions that wrap the user function with `catchTo` (§11) before constructing the atom via `nstep` (§3.3–§3.5):

- **`step(fn)`** — wraps `fn` in an inner that discards `fn`'s return and explicitly returns `'success'`, then `catchTo(inner, 'failure')`, then `nstep(...)` with `inputs: ['success']`, `outputs: ['success', 'failure']`. `__rail_kind__: 'atom'`.
- **`pass(fn)`** — wraps `fn` in an inner that discards `fn`'s return and explicitly returns `'success'`, then `catchTo(inner, 'success')`, then `nstep(...)` with `inputs: 'success'`, `outputs: 'success'`. `catchTo` only intervenes on throw. `__rail_kind__: 'atom'`.
- **`fail(fn)`** — same shape as `pass` with `'failure'` everywhere. `__rail_kind__: 'atom'`.

Because `catchTo` wraps the user function (not the node), `step`/`pass`/`fail` produce ordinary atoms with no wrapper layer — the atom itself sees a function that returns a clean exit string. The runtime never observes a user-thrown exception from these builders; `RailError` and `RailAggregateError` propagate unchanged (`catchTo` re-throws them).

Implementations may inline the factories rather than literally calling `nstep(...)` and `catchTo(...)`; the observable contract is the definition given in §3.3–§3.5.

### 15.5 `pin` implementation sketch

```js
function pin(inner, pinnedEntry) {
  if (!isRailNode(inner)) {
    throw new RailBuildError('NOT_A_NODE', { details: { arg: 'inner' } });
  }
  if (typeof pinnedEntry !== 'string'
      || !inner.inputs.includes(pinnedEntry)) {
    throw new RailBuildError('UNRESOLVED_WIRE_REFERENCE', {
      details: { ref: String(pinnedEntry), validInputs: inner.inputs },
    });
  }

  const node = {
    __rail_type__: 'node',
    __rail_kind__: 'pin',
    inputs: ['in'],
    outputs: inner.outputs,
    _inner: inner,
  };

  node._invoke = (entry, ctx, local, runState, path) =>
    // outer 'in' maps to the inner's chosen entry:
    inner._invoke(pinnedEntry, ctx, local, runState, path);

  return node;
}
```

`pin` transforms only the `entry` argument: an outer `'in'` activation becomes an inner activation at the pinned entry. The incoming `ctx`, `local`, `runState`, and `path` pass through unchanged. Trace-transparent per §2.

### 15.6 `parallel` implementation sketch

```js
function parallel(branches, merge) {
  validateParallelBuild(branches, merge);
  const node = {
    __rail_type__: 'node',
    __rail_kind__: 'parallel',
    inputs: ['in'],
    outputs: merge ? [...merge.outputs] : ['out'],
    _branches: branches,
    _merge: merge,                    // undefined if no merge
  };

  node._invoke = (entry, ctx, local, runState, path) =>
    invokeNode(doParallel, 'parallel',
               entry, ctx, local, runState, path);

  async function doParallel(entry, ctx, local, runState, path) {
    if (!local.branches) local.branches = {};

    const branchNames = Object.keys(branches);
    // Per-branch ctx copies — remembered here so we can build the
    // aggregated result; _invoke itself does not return ctx (§2.1).
    const branchCtxes = {};

    // Each branch promise is wrapped: on the *first* rejection across
    // all branches, fire runState.internalAbortController.abort() so
    // that sibling branches still running observe runInfo.signal.aborted
    // and can exit cooperatively. The wrapped promise itself still
    // rejects with the original reason — we use allSettled below to
    // collect the final state of every branch (including those that
    // raced through their work before the signal flipped, and those
    // that ignored the signal).
    const promises = branchNames.map(
      (branchName) => {
        const branchNode = branches[branchName];
        if (!local.branches[branchName]) {
          local.branches[branchName] = {};
        }
        const branchLocal = local.branches[branchName];
        const branchPath = [...path, branchName];
        const branchEntry = branchNode.inputs[0];
        if (!branchEntry) {
          // Defensive: the parallel builder requires every branch to
          // have exactly one input (§8.1). Reachable only if a custom
          // kind constructed an invalid branch node bypassing the
          // builder.
          throw new RailRuntimeError('INTERNAL', {
            flowName: runState.flowName,
            details: { invariant: 'branch node has no input',
                       branch: branchName },
          });
        }

        // Shallow-copy ctx per branch so branches do not race on
        // the same top-level object (§8). We hold each copy so we
        // can read the branch's final ctx after _invoke returns.
        const branchCtx = { ...ctx };
        branchCtxes[branchName] = branchCtx;
        const p = branchNode._invoke(
          branchEntry, branchCtx, branchLocal, runState, branchPath,
        );
        // Trigger the internal abort eagerly on the first failure;
        // subsequent .catch handlers also call abort() but abort() is
        // idempotent (no-op once already aborted).
        return p.catch((err) => {
          runState.internalAbortController.abort();
          throw err; // re-throw so allSettled records it as 'rejected'
        });
      },
    );

    // Settled preserves the input order of promises, so
    // settled[i] always corresponds to branchNames[i].
    const settled = await Promise.allSettled(promises);

    const branchErrors = {};
    for (let i = 0; i < settled.length; i++) {
      if (settled[i].status === 'rejected') {
        const reason = settled[i].reason;
        // Non-library throws from a branch are bugs — wrap them as
        // UNHANDLED_THROW so the aggregate's errors[] is always
        // (RailError | RailAggregateError)[]. `flowName` is left for
        // flow.run's classification boundary to fill in (§9).
        const wrapped = reason instanceof RailError
          ? reason
          : new RailRuntimeError('UNHANDLED_THROW', {
              cause: reason,
              flowName: runState.flowName,
            });
        // Walking branchNames in order preserves declaration order in
        // the resulting object's keys.
        branchErrors[branchNames[i]] = wrapped;
      }
    }
    if (Object.keys(branchErrors).length > 0) {
      // The internal abort was already fired by the per-branch
      // .catch wrapper on the first rejection (above), so sibling
      // branches had the chance to exit cooperatively. flowName is
      // set by flow.run's classification boundary if missing.
      // The merge node is NOT invoked when any branch rejected.
      throw new RailAggregateError(branchErrors);
    }

    // Replace the incoming ctx in place with the aggregated
    // { branchName: branchCtx, ... } shape: clear all keys, then
    // assign the branch ctxes.
    for (const k of Object.keys(ctx)) delete ctx[k];
    for (const branchName of branchNames) {
      ctx[branchName] = branchCtxes[branchName];
    }

    // Without merge: return the fixed exit 'out'.
    if (!merge) return 'out';

    // With merge: invoke the merge node with the aggregated ctx as
    // its input. The merge node uses its own local slot (local._merge,
    // independent of local.branches) and a path extended by the
    // reserved marker '__merge__'. Throws propagate (the merge node
    // is invoked like any atom).
    if (!local._merge) local._merge = {};
    const mergePath  = [...path, '__merge__'];
    const mergeEntry = merge.inputs[0];
    return await merge._invoke(
      mergeEntry, ctx, local._merge, runState, mergePath,
    );
  }

  return node;
}
```

**Aggregation rule (§8):** every branch rejection produces a `RailAggregateError`, including the single-rejection case. The library does not unwrap a single rejection to its original error — the aggregate form is the uniform contract.

**Merge invocation rule (§8):** the merge node runs *only* when all branches resolve. Any branch rejection short-circuits to `RailAggregateError` and skips the merge entirely.

`runState.internalAbortController.abort()` is the mechanism by which a failing branch terminates its siblings: their `runInfo.signal.aborted` becomes `true`, and any branch that polls the signal can exit cooperatively.

### 15.7 `activity` graph walk

The activity's `doInvoke` walks the graph from the chosen entry to whichever exit is reached:

```js
async doInvoke(entry, ctx, local, runState, path) {
  // Resolve the entry to its first downstream endpoint:
  let currentEndpoint = this._wires.followFromEntry(entry);

  while (currentEndpoint.__rail_kind__ === 'in') {
    // It's a sub-node input — invoke the sub-node:
    const subNode  = currentEndpoint.node;
    const subName  = currentEndpoint.localName;
    const subEntry = currentEndpoint.portName;

    // Ensure local storage for this sub-position:
    if (!local.children)          local.children          = {};
    if (!local.children[subName]) local.children[subName] = {};
    const subLocal = local.children[subName];

    const subPath = [...path, subName];

    // ctx is passed by reference; sub-nodes mutate it directly.
    const exit = await subNode._invoke(
      subEntry, ctx, subLocal, runState, subPath
    );

    currentEndpoint = this._wires.followFromOut(subNode, exit);
  }

  // currentEndpoint is now an exit endpoint. Defensive: with a
  // hand-assembled custom-kind activity, an endpoint of an
  // unexpected kind could reach this point.
  if (currentEndpoint.__rail_kind__ !== 'exit') {
    throw new RailRuntimeError('INTERNAL', {
      flowName: runState.flowName,
      details: { invariant: 'activity walk reached non-exit endpoint',
                 endpoint: currentEndpoint.__rail_kind__ },
    });
  }
  return currentEndpoint.portName;
}
```

The walk terminates when the followed wire reaches an endpoint of kind `'exit'`. Cycles are allowed and produce repeated invocations of the same sub-position; see §5.6 for cycle semantics and §13.5 for the `maxSteps`/cycle-counter behaviour.

The walk is direction-asymmetric: it follows wires from source to target, and each source (activity entry or sub-node output) has exactly one outgoing wire (§5.3). Convergence — multiple wires ending at the same target endpoint — therefore needs no resolution in the walk; each walker arrives along its own source-side wire, independently of any other wire that happens to terminate at the same target.

### 15.8 `flow.toMermaid()` rendering

Walk the held node. For each sub-node, the renderer calls `node.toMermaid(name, opts)` if the node exposes that method; otherwise it falls back to the **default atomic rendering**: a rectangle labelled with the local name, with one outgoing edge per declared output.

The hook is outside the Node contract (§2). Generic tooling tests for its presence with `typeof node.toMermaid === 'function'`. Custom kinds can expose their own hook with the same signature or accept the default.

The observable output is specified in §2.4 (subgraph form, wire form, escaping, top-level rendering, multi-position behaviour).

### 15.9 Tracer dispatch

Tracer events are dispatched at two points inside `invokeNode` (§15.3): on begin (entry constructed, `startTime` set, `ctx`/`local` snapshotted), on end (after a successful return, with `endTime` and `exit` set). Steps that throw produce no further tracer event — the entry remains unfilled and the throw propagates.

Each dispatch is wrapped in try/catch per `runState.tracerErrorPolicy`. Under `'swallow'` (the default) the exception is dropped silently — no synthetic TraceEntry is fabricated. Under `'throw'` the exception propagates out of the run.

### 15.10 Validation orchestration in the builders

The whole-graph validation walk used by `activity`, `nrail`, `railway`, and `parallel` shares a common identity-memoised traversal. A typical implementation uses a `WeakSet` to memoise visited node identities for the duration of the walk:

```js
function validateGroup(node, visit) {
  const seen = new WeakSet();
  function walk(n) {
    if (seen.has(n)) return;
    seen.add(n);
    visit(n, walk);
  }
  walk(node);
}
```

The `visit` callback is the group-kind-specific validator: for an activity, it checks the structural rules in §5.6 and recurses into each sub-node via `walk`; for parallel, it checks each branch and recurses; for `pin` (encountered as a sub-node), it recurses into `_inner`. Atomic nodes contribute nothing to the walk — their invariants were enforced eagerly in their own builder.

This memoisation makes the walk linear in the number of distinct node instances, not in the number of positions they occupy in the assembled graph (§5.6).

---

## 16. Acceptance criteria

A correct implementation of rail.js v0.3.0 satisfies all of the following. Each item is a test that should pass.

### 16.1 Node and ctx markers

1. Every node value `n` produced by a public builder has `n.__rail_type__ === 'node'`.
2. The `__rail_kind__` of a node value matches the builder that produced it: `'atom' | 'pin' | 'activity' | 'parallel'` for built-ins. The `nstep`, `step`, `pass`, and `fail` factories all produce `'atom'` nodes.
3. `isRailNode(n)` returns `true` for any value with `__rail_type__ === 'node'`.
4. Every node exposes `_invoke`, `__rail_type__`, `__rail_kind__`, `inputs`, and `outputs`. The library defines no public methods on the node beyond `toMermaid` where applicable (group nodes); validation methods are not part of the user-facing API (§1.5).
5. Endpoint markers `__rail_type__: 'endpoint'` are internal-only and not observable from user code.

### 16.2 Invoke contract

6. Every node exposes `_invoke(entry, ctx, local, runState, path)` returning `Promise<string>` where the string is the chosen exit name. The node mutates `ctx` in place; there is no return-channel for ctx.
7. `_invoke` of atomic and group nodes (`activity`, `parallel`) calls `invokeNode(doInvoke, kind, ...)` internally.
8. `_invoke` of `pin` does **not** call `invokeNode` and produces no trace entry.
9. The `path` argument is a `string[]` extended by each group node on its way in.

### 16.3 Trace shape

10. Every `TraceEntry` has the fields `{ path, kind, cycle, entry, ctx, local, startTime, endTime?, exit? }`.
11. `ctx` and `local` in `TraceEntry` are shallow copies taken at push time.
12. On successful completion: `endTime` and `exit` are populated.
13. On throw: the entry remains in the trace with `endTime` and `exit` undefined. The throw propagates and terminates the run.

### 16.4 Tracer

14. The tracer is called with `(entry, event)` where `event ∈ {'begin', 'end'}`.
15. A clean run pairs every tracer `'begin'` event with exactly one subsequent `'end'` event for the same entry. If a step throws, no `'end'` follows — the entry remains unfilled and the throw terminates the run. Step-budget and kill failures throw before `'begin'` fires.
16. Wrappers (`pin`) emit no tracer events.
17. Tracer exceptions follow `tracerErrorPolicy` (`'swallow'` is the default).
18. No synthetic TraceEntry is fabricated when the tracer throws.

### 16.5 Atomic builders

19. `atom(fn, { inputs?, outputs })` requires `outputs` to be a non-empty array of unique valid names; `inputs` defaults to `['in']`. `__rail_kind__: 'atom'`.
20. `atom`'s user function returns the exit name as a string; an exit not in `outputs` triggers `RailRuntimeError(UNKNOWN_OUTPUT_AT_RUNTIME)`.
21. `nstep(fn, inputs, outputs)` accepts string-or-array `inputs` and `outputs`, each normalised to an array of unique valid names. The resulting node has `__rail_kind__: 'atom'`, with `inputs` and `outputs` as given. With a single output, the user function may return `undefined` (no explicit return), `null`, or the output name as a string — all three yield that output. With multiple outputs, the user function must return one of the declared outputs. Any other return value (including nullish for a multi-output node) raises `RailRuntimeError(UNKNOWN_OUTPUT_AT_RUNTIME)`.
22. `step(fn)` produces an atom (`__rail_kind__: 'atom'`) with `inputs: ['success']`, `outputs: ['success', 'failure']`, built by wrapping `fn` with `catchTo` (§11) inside `nstep`. Normal return → `'success'`; caught non-library exception → `'failure'` with `ctx._error` set.
23. `pass(fn)` produces an atom with `inputs: ['success']`, `outputs: ['success']`. An inner wrapper discards `fn`'s return and explicitly returns `'success'`; the outer construction is `nstep(catchTo(inner, 'success'), 'success', 'success')`. Both normal return and caught non-library exception → `'success'`; caught case sets `ctx._error`.
24. `fail(fn)` produces an atom with `inputs: ['failure']`, `outputs: ['failure']`. An inner wrapper discards `fn`'s return and explicitly returns `'failure'`; the outer construction is `nstep(catchTo(inner, 'failure'), 'failure', 'failure')`. Both normal return and caught non-library exception → `'failure'`; caught case sets `ctx._error`.
25. `RailError` and `RailAggregateError` propagate out of `step`/`pass`/`fail` — `catchTo` always re-throws library errors (§11).
26. `catchTo(fn, exitName)` is a user-function wrapper that catches non-library exceptions, sets `ctx._error`, and returns `exitName`. Library errors propagate unchanged. The wrapped function may be passed to any atomic builder.

### 16.6 Wrappers

27. `pin(node, entry)` validates `entry` against `node.inputs` at build time (raises `RailBuildError(UNRESOLVED_WIRE_REFERENCE)` otherwise).
28. `pin` has `inputs: ['in']`, `outputs: node.outputs`, and exposes `_inner: node`.
29. `pin`'s `_invoke` re-routes the outer `'in'` activation to the inner node at the pinned entry; `ctx`, `local`, `runState`, and `path` pass through unchanged.
30. `pin` is the only built-in wrapper. The library does not provide a node-level exception catcher; exception routing is done on the user function via `catchTo` (§11).

### 16.7 Activity

31. `activity(builder)` runs `builder(a)` synchronously, then seals the activity, then runs the whole-graph validation walk (§5.6) before returning.
32. `a.entry(...names)`, `a.exit(...names)`, `a.addNode(name, node)`, `a.wire(src, tgt)` are the builder API; all return nothing. `entry` and `exit` accept one or more names per call.
33. Wire strings are `'<sub>.<port>'` or `'.<port>'` (the empty sub-name `''` refers to the activity itself); the dot is always required.
34. The whole-graph validation walk in `activity(builder)` raises `RailBuildError` for missing entries/exits, duplicate names, unused outputs, an output with more than one outgoing wire, unresolved wire references, and direction-invalid wires.
35. Multiple incoming wires to the same target endpoint (a sub-node input or an activity exit) are **allowed** (convergence).
36. Activity satisfies `isRailNode(a) === true` and `a.__rail_kind__ === 'activity'`.

### 16.8 Parallel

37. `parallel(branches, merge?)` requires at least one branch; every branch must have exactly one input. If `merge` is given, it must be a Rail-Node with exactly one input.
38. A multi-input branch node or a multi-input merge node raises `RailBuildError(MULTI_INPUT_NODE)` at build time.
39. Parallel always exposes `inputs: ['in']`. `outputs` is `['out']` without a merge node, or the merge node's `outputs` with one.
40. The aggregated ctx after branches resolve is a plain object `{ branchName: branchCtx, ... }`; branch names match the branch keys in declaration order. Without a merge node, this is the parallel's final ctx and the exit is `'out'`. With a merge node, this aggregated ctx is then passed to the merge node, whose final ctx and chosen exit become the parallel's outputs.
41. Branch ctxes are produced from a per-branch shallow copy of the incoming ctx (§8).
42. A failing branch aborts siblings via the internal abort controller; sibling branches see `runInfo.signal.aborted === true`.
43. **Every** branch rejection — including the single-rejection case — is delivered as a `RailAggregateError`, with rejections aggregated in branch declaration order. When any branch rejects, the merge node (if configured) is not invoked.
44. The merge node, when invoked, uses its own `local._merge` slot (independent of `local.branches`) and a path extended by the reserved marker `'__merge__'`. Throws from the merge node propagate as in any atom.
45. No branch name in `parallel(...)` may be `'__merge__'` (reserved); violation raises `RailBuildError(INVALID_NAME)`.

### 16.9 n-Rail

46. `nrail(builderFn)` produces an Activity (`__rail_kind__: 'activity'`) by running `builderFn(r)` and then running the activity's whole-graph validation walk (§5.6) on the assembled activity.
47. `r.entry(...names)` must be called exactly once, before any other builder method. Multiple names are accepted; the activity's `inputs` follow the declared order.
48. `r.step(name, fn, inputs, outputs)` is equivalent to `r.addNode(name, nstep(fn, inputs, outputs))` — no automatic catching.
49. `r.addNode(name, node)` reads `node.inputs` and `node.outputs` directly, treating endpoint names as rails for Live-Set bookkeeping; no inputs/outputs arguments.
50. The Live-Set is maintained according to §6.7's uniform rule: each operation consumes entries on its declared input rails (per-rail convergence) and produces entries on its declared output rails.
51. A consume-operation that references a rail not in the Live-Set raises `RailBuildError(RAIL_NOT_LIVE)`. The error message lists the available rails.
52. `r.label(name, rail)` adds a no-op node with `inputs: ['in']`, `outputs: [rail]`, consuming nothing from the Live-Set. The label's input endpoint is reachable only via `r.link`.
53. `r.link(labelName, rail)` consumes all Live-Set entries on `rail` and creates wires to `labelName.in`. If the label is not yet declared, the link is deferred and resolved when the label is later registered.
54. At build end: pending links left unresolved raise `RailBuildError(UNKNOWN_LABEL)`; labels with no incoming wire raise `RailBuildError(UNUSED_LABEL)`.
55. At build end: every rail still in the Live-Set produces an Activity exit of the same name (in order of first appearance across the builder). Remaining entries are wired to those exits (with per-exit convergence for multiple entries on the same rail).

### 16.10 Railway

56. `railway(builderFn)` produces an Activity (`__rail_kind__: 'activity'`) with `inputs: ['success']` and `outputs: ['success', 'failure']`, implemented as a thin wrapper over `nrail(...)`.
57. `r.step(name, fn)` is equivalent to `r.step(name, catchTo(fn, 'failure'), 'success', ['success', 'failure'])` on the underlying `nrail` builder.
58. `r.pass(name, fn)` is equivalent to `r.step(name, catchTo(fn, 'success'), 'success', 'success')`.
59. `r.fail(name, fn)` is equivalent to `r.step(name, catchTo(fn, 'failure'), 'failure', 'failure')`.
60. `r.fail` declared before any `r.step` raises `RailBuildError(RAIL_NOT_LIVE)` from the underlying `nrail` layer (no `failure` rail entry exists yet).

### 16.11 Flow

61. `flow(name, node)` is a factory; returns an object with `name`, `node`, `run`, `toMermaid`.
62. `flow(...)` requires `name` to satisfy §5.1's name rules (raises `RailBuildError(INVALID_NAME)` otherwise), `isRailNode(node)` (raises `RailBuildError(NOT_A_NODE)` otherwise), and `node.inputs.length === 1` (raises `RailBuildError(MULTI_INPUT_NODE)` otherwise).
63. `flow.run(ctx, opts?)` does not re-validate the held node; the built-in builders ensure all node values they produce are ready to use (per-kind rules in §3, §4.1, §5.6, §6.10, §7.5, §8.1). Custom-kind authors are responsible for the consistency of nodes they construct without a builder.
64. `flow.run(ctx, opts?)` returns `Promise<RunResult>` on success, with `RunResult` shape `{ exit, ctx, trace }`.
65. `flow.run` does not modify the held node.
66. The same flow object can be invoked many times, including concurrently.
67. A flow holding a single `step` (`flow('greet', step(async (ctx) => { ctx.greeted = true; }))`) run with `flow.run({})` resolves to a `RunResult` whose `exit === 'success'`, `ctx.greeted === true`, and `trace.length === 1`. The single trace entry has `path === []` (top-level position has no name), `kind === 'atom'`, `cycle === 1`, `endTime > startTime`, and `exit === 'success'`.

### 16.12 Cancellation and budget

68. `opts.killSignal` aborts the run; when it fires, `invokeNode`'s kill check throws `RailRuntimeError(KILLED)` at the next node boundary (§13.4). The signal's `reason` is not surfaced as the thrown value; callers can inspect `killSignal.reason` themselves if needed.
69. `runInfo.signal` is the combined signal (caller's `opts.signal` ∪ caller's `opts.killSignal` ∪ library's internal abort, §13.4).
70. `opts.maxSteps` defaults to the library default `1000` and triggers `RailRuntimeError(STEP_BUDGET_EXCEEDED)` when exceeded.

### 16.13 Validation

71. Every built-in builder fully validates its result before returning, combining eager per-operation checks (§1.5) with a whole-graph walk for group builders (per-kind rules in §3, §4.1, §5.6, §6.10, §7.5, §8.1). A node value handed back from `atom`, `nstep`, `step`, `pass`, `fail`, `pin`, `activity`, `nrail`, `railway`, or `parallel` is ready to use; no separate validation step is required.
72. Validation failures raise `RailBuildError` at the offending builder call site, with codes from §12.2. The errors are synchronous to the builder operation that caused them.
73. Within a group builder's whole-graph walk, a node instance reachable from multiple positions in the assembled sub-graph is walked once (identity-based memoisation, §5.6). Self-reference is structurally impossible (§5.5.5).
74. A group-builder closure (`activity`, `nrail`, `railway`) that returns a non-`undefined` value — typically a Promise from an `async` function — raises `RailBuildError(ASYNC_BUILDER)` at the builder call site.
75. After a group-builder closure returns, any subsequent method call on the builder reference (`a.entry`, `a.exit`, `a.addNode`, `a.wire`, `r.step`, `r.entry`, `r.label`, `r.link`, `r.addNode`, `r.pass`, `r.fail`, etc.) raises `RailBuildError(SEALED)`.

### 16.14 Errors

76. `e instanceof RailError` returns `true` for `RailError`, `RailRuntimeError`, `RailBuildError`, and `RailAggregateError`.
77. Every library error has a `code` field from a catalogue in §12.
78. `RailAggregateError` exposes its constituent errors at `e.branchErrors` (a `{ branchName: error }` object) and as a derived `e.errors` array view (`Object.values(branchErrors)`), set by the constructor.
79. Library errors never appear inside a `RunResult`'s `ctx` or `exit` — they propagate as thrown values (§12.3).

### 16.15 Extension

80. `invokeNode` is exported from the public API and callable from user code for custom node kinds.
81. A node value with `__rail_type__: 'node'`, `__rail_kind__: '<custom>'`, `inputs`, `outputs`, and an `_invoke` of the right shape is accepted by `a.addNode`, `pin(...)`, and `flow(...)` like a built-in. Custom-kind authors are responsible for ensuring the node's internal state is consistent before it is used; the library does not validate custom kinds (§2).

---

## 17. Notes on common patterns

A few patterns the library does **not** provide as built-ins but which users commonly need:

- **Retry loops.** Implemented as user-written subgraphs with cycle wires; the position's `local` carries the attempt counter and the step budget (§13.5) bounds total iterations. See §14.13 for a full example.
- **Per-node timeouts.** Implemented in user code via `Promise.race` with a timeout promise that throws — the resulting throw is caught by `step` (or any `catchTo`-wrapped user function) and routed as usual. `runState.internalAbortController` is library-internal and not exposed; users wire their own `AbortController` into `runInfo.signal`-aware code (§14.10).

---

## 18. Glossary

**`__rail_type__`** — Marker field present on every value the library hands out. Always one of `'node' | 'endpoint'`. Allows host code to recognise rail values without `instanceof` checks.

**`__rail_kind__`** — Subtype marker. For nodes: `'atom' | 'pin' | 'activity' | 'parallel' | <custom>`. For endpoints: `'entry' | 'exit' | 'in' | 'out'`. (Contexts are plain objects; the library does not mark them.)

**Activity** — A graph-based group node containing sub-nodes connected by wires. Built via `activity(builder)`. Can be held by a `flow(...)` or used as a sub-node inside another activity.

**Atomic Node** — A node with no sub-nodes; performs its work by calling a user function. The only built-in atomic kind is `'atom'`. See §2.

**Atomic builder** — `atom`, plus the convenience layer `nstep` and the factories `step`, `pass`, `fail`. `atom` is the primitive; `nstep` provides string-or-array inputs/outputs and single-output nullish-return convenience over `atom`; `step`/`pass`/`fail` wrap the user function with `catchTo` (§11) before constructing the atom via `nstep`, giving fixed rail-named inputs/outputs and exception-to-exit routing (§3.2–§3.5). All five builders produce `'atom'` nodes.

**Branch** — A node supplied as a value in `parallel({ branchName: node, ... })`. Each branch must have exactly one input.

**`catchTo`** — User-function-level wrapper: `catchTo(fn, exitName)`. Catches non-library exceptions thrown by `fn`, sets `ctx._error`, and returns `exitName`. Library errors (`RailError`, `RailAggregateError`) propagate unchanged. The only catching mechanism in the library; `step`/`pass`/`fail`/`railway` are built on it. For multi-error-class routing, write a plain user function with explicit branching — no library wrapper exists for that (§11).

**Context (`ctx`)** — The user-supplied data carried along wires. Plain object. The library reserves the `_error` field name for the error placed by `step`, `pass`, `fail`, or any user function wrapped with `catchTo` on caught exceptions. `parallel` produces a `{ branchName: branchCtx, ... }` ctx (§8); a merge node, if configured, then replaces that with its own final shape.

**Cycle (cycle counter)** — The invocation count at a given position in the run, recorded on the TraceEntry as `cycle`. First invocation: 1, second: 2, etc. Stored on `local._cycles` at each position. Cycles are local to a position — they are *not* "full activity-traversals"; they count how many times the specific node at that position has been activated during the run.

**Flow** — The value returned by `flow(name, node)`. Stateless runnable wrapper around a top-level node. Holds `name`, `node`, `run`, `toMermaid`. The same flow can be invoked many times, concurrently.

**Group-Node** — A node that contains one or more sub-nodes and owns their local state: `activity` (`local.children`) and `parallel` (`local.branches`, plus `local._merge` if a merge node is configured).

**Merge node** — An optional second argument to `parallel(branches, merge)` (§8). When configured, the parallel invokes it after all branches resolve, with the aggregated `{ branchName: branchCtx, ... }` as its input. The merge node's `outputs` become the parallel's `outputs`. Skipped entirely when any branch rejected.

**`invokeNode`** — Central plumbing helper. Frames each node invocation with trace push/begin/end, step-budget check, signal check, and a shallow snapshot of `ctx` and `local` for the TraceEntry. Exported for custom node kinds.

**Inner (`_inner`)** — Convention: a wrapper node (e.g. `pin`) exposes its underlying node as `_inner`. Read-only for users.

**Library error** — Any error class produced by rail: `RailError`, `RailRuntimeError`, `RailBuildError`, `RailAggregateError`. Recognisable via `e instanceof RailError`.

**Label** — In `nrail`, a named anchor declared via `r.label(name, rail)`. Has a single input endpoint named `in`, reachable only via `r.link(labelName, rail)`. Produces one Live-Set entry on its rail. Implemented as a no-op atom; visible in trace and Mermaid output. Enables loops and forward references without breaking the linear builder structure.

**Link** — In `nrail`, a jump-wire from a Live-Set entry to a label's input, declared via `r.link(labelName, rail)`. Consumes all Live-Set entries on the named rail, creates one wire per consumed source to the label's `in` endpoint, and produces nothing. The link itself is *not* a node — it is a pure wire instruction. Forward links (link before label) are supported via a deferred pending-links list.

**Live-Set** — The build-time bookkeeping structure of `nrail`. An ordered list of `(rail, sourceEndpoint)` pairs representing open wires waiting for a consumer. Every builder operation consumes entries by rail name (creating per-rail convergent wires) and/or produces entries. At build end, the remaining entries are wired to Activity exits. The Live-Set exists only during the build; it has no runtime representation.

**Local state (`local`)** — Per-position mutable storage for a node, persisting across all activations of the position within a single `flow.run(...)` and freshly empty for each new run. Hierarchical for group nodes: `local.children[subName]` for Activities, `local.branches[branchName]` for Parallel. The cycle counter is stored as `local._cycles`.

**n-Rail** — An Activity factory for pipelines with `n` parallel outcome tracks ("rails"). Built via `nrail(builderFn)`. Generalises Railway (which is fixed at 2 rails); steps consume and produce named rails, the builder maintains a Live-Set of open wires, and rails still live at build end become Activity exits. Throws are not caught automatically — `catchTo` provides opt-in throw-to-exit routing (§6).

**`nstep`** — Atom convenience constructor: `nstep(fn, inputs, outputs)`. Provides string-or-array normalisation and single-output nullish-return convenience over `atom`. The atom's `__rail_kind__` is `'atom'`. Used directly in `activity(...)` for multi-input/multi-output atoms; used internally by `nrail`'s `r.step`. The factories `step`/`pass`/`fail` are built on `nstep` (§3.2).

**`path`** — Array of local names from the top-level node down to the current node. Identifies a position uniquely within a run; the trace stores it as a string-array and joins it with `'.'` only on demand.

**`pin`** — Wrapper that fixes one of a multi-entry node's inputs. The pin's outer interface has a single input `'in'`, which routes through to the inner node's chosen entry. Transparent in the trace. Used wherever a single-entry node is required (top-level of `flow(...)`, Parallel branches).

**Rail** — In `nrail` and `railway`, a named track along which control flows from one step's output to another step's input. Rail names are the same names as endpoint names (`name.<rail>`); each step declares its input rails and output rails explicitly. Rails are a build-time concept — they exist in the Live-Set and as endpoint names, but at runtime a step is a normal atom and an invocation follows a single wire chain through the graph.

**Railway** — A convenience builder for the Trailblazer-style two-track success/failure pipeline. Implemented as a thin wrapper over `nrail` (§7) using `catchTo` for automatic exception routing. Three builder methods (`r.step`, `r.pass`, `r.fail`) map to `nrail` steps on rails `success`/`failure`. The result is an ordinary Activity (`__rail_kind__: 'activity'`) with `inputs: ['success']` and `outputs: ['success', 'failure']`.

**`runInfo`** — The third argument passed to user functions of atomic builders. Shape: `{ signal, flowName, traceEntry }`. Read-only.

**`runState`** — The runtime carrier through a single flow run. Holds trace, step counter, budget, signals, tracer/logger references. Single object, no forking; passes by reference through every `_invoke` call in the run.

**Step budget** — Hard upper bound on the number of node invocations in a single run. Exceeding it throws `RailRuntimeError(STEP_BUDGET_EXCEEDED)`.

**Sub-activity** — An Activity used as a sub-node inside another Activity. Mechanically identical to a top-level Activity; "top-level" vs. "sub" is a positional distinction only.

**TraceEntry** — One record in the run trace. See §9 for the authoritative shape.

**Tracer** — Optional synchronous callback receiving `(entry, event)` for each successfully completed node invocation. Two events: `'begin' | 'end'`.

**Wire** — A directed connection inside an Activity from one source endpoint to one target endpoint. String-addressed; the dot is always required.

**Wrapper-Node** — A node that delegates its invocation to a single inner node (exposed as `_inner`), transforming parameters or result. Transparent in the trace: no TraceEntry, no path extension, no `invokeNode` call, no `local` slot. The only built-in kind is `'pin'`. See §2.

**Wrapper builder** — `pin`. The factory function that produces a Wrapper-Node from an inner node.

---

## 19. Release notes for spec v0.3.0

This is the **first published v0.3.0 spec**. It supersedes pre-release drafts and is the reference against which an initial implementation should be written. Once an implementation passes the acceptance criteria (§16) and the spec text is reviewed, v0.3.0 is considered released; subsequent revisions go to v0.3.x for patches, v0.4.x for additive features, v1.x.x for breaking changes.

Notable shape of v0.3.0:

- Plain ES modules + JSDoc, no TypeScript, no runtime dependencies. Runs on modern Node and modern browsers with native ESM support; no build step required.
- Single-package, single-realm runtime.
- Validation in two complementary places, both internal to the builders: eager per-operation checks plus a whole-graph walk at the end of group builders.
- Custom node kinds are first-class via `__rail_type__` markers and exported `invokeNode`.
- Five atomic builders forming a clean hierarchy: `atom` (primitive) → `nstep` (string-or-array inputs/outputs, single-output nullish-return convenience) → `step`/`pass`/`fail` (`catchTo`-wrapped with fixed rail-named inputs). All five produce `'atom'` nodes.
- `nrail(builderFn)` for pipelines with n parallel outcome tracks: declarative steps consume and produce named rails via a build-time Live-Set; labels and links enable loops and forward references. `railway(...)` is a thin wrapper over `nrail` using `catchTo` for automatic exception routing.
- `parallel(branches, merge?)` runs branches concurrently; an optional second argument supplies a merge node that post-processes the aggregated branch ctxes and determines the parallel's exit. Without a merge node, the parallel exposes a single `'out'` exit; with one, the merge's outputs become the parallel's outputs.
- `catchTo(fn, exitName)` is the sole exception-handling mechanism: a user-function-level wrapper for opt-in throw-to-exit routing. Library-thrown exceptions terminate the run; there is no node-level catching wrapper.
- Trace is a flat array of TraceEntries with hierarchical `path: string[]`. A clean run pairs every `'begin'` tracer event with one `'end'`; a library throw leaves the final entry unfilled and propagates without further trace bookkeeping. TraceEntry has no `error` field; library errors do not carry the trace.

---

## Appendix A — Marker fields

The library tags its plain-object values with two string markers so that host code can recognise them without `instanceof` checks. The full set of values:

| `__rail_type__` | `__rail_kind__`                                                                                            |
|-----------------|------------------------------------------------------------------------------------------------------------|
| `'node'`        | `'atom'`, `'pin'`, `'activity'`, `'parallel'`, or any user-defined string                                  |
| `'endpoint'`    | `'entry'`, `'exit'`, `'in'`, `'out'` — library-internal, not exposed in user code (§5.2)                   |

Code that needs to recognise "any rail node" uses `isRailNode(value)` (§10.1). Code that discriminates between kinds reads `node.__rail_kind__`.
