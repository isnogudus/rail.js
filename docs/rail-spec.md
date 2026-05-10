# `rail.js` — Specification

A small workflow library for JavaScript. Plain JS with JSDoc, no
dependencies, no persistence, no runtime magic. Workflows are
explicit, validated graphs of named steps that you can render
(Mermaid) and trace (log).

This document is the implementation spec. It is meant to be handed
to an agent (Claude Code) as the source of truth for building the
library. Code examples are illustrative — the agent should match
the public API and semantics described here, not copy snippets
verbatim.

---

## 1. Goals and non-goals

### Goals

- Express business logic as a **graph of named nodes** with explicit
  **named outputs** ("tracks").
- Catch structural errors at **compile time**, not at run time.
- Provide a clear, useful **trace** for every run, with per-step
  timing, taken track, and any error.
- Render the graph as **Mermaid** for documentation and debugging.
- Stay **plain JS + JSDoc**, no TypeScript, no dependencies.
- Be **async** end to end.
- Compose: an activity can be embedded as a node in another activity
  (sub-activities).
- Support **parallel execution** of activities through a single,
  well-defined construct.
- Cleanly **separate node construction from node naming**:
  factories build context-free node values; the builder gives them
  names when adding them to a graph.

### Non-goals

- No persistence. The library does not store run state to disk.
- No durable execution, no resume-after-crash semantics.
- No serverside cluster, no distribution.
- No framework integration (Svelte/React/etc). Tracing goes through
  a pluggable logger (default: `console.log`).
- No cycles in the graph (initial version).
- No fan-out via wire topology. Parallelism is expressed through
  the `parallel(...)` library construct (§3.7).
- **Convergence (multiple wires ending at the same node-input) is
  allowed** and orthogonal to parallelism — see §7.5.

### Relation to monadic pipelines

For readers with a functional-programming background: Rail graphs
are a superset of monadic pipelines. A linear graph in which every
node has two outputs (`success`/`failure`) is structurally `StateT`
over `Either` — the same shape as Trailblazer's railway-oriented
programming or `Result`-chains in Rust/Swift/F#. Monads, in this
sense, are the special case of Rail graphs that happen to be linear
and binary. Rail generalises in two directions: outputs can be
n-ary instead of binary, and the composition is an explicit,
validated graph rather than implicit `bind`-chaining.

---

## 2. Conceptual model

The library has three primary concepts: **Node**, **Activity**, and
**Flow**, with a clear separation of concerns:

- A **Node** *is* something — it has an implementation and ports.
  It does not have a name; that is a property of its use.
- An **Activity** is a Node whose implementation is itself a graph
  of named sub-nodes connected by wires.
- A **Flow** is a runtime wrapper that holds a top-level Node, a
  top-level name, and `run(ctx, opts)` for execution. (The term
  follows BPMN's Sequence Flow / Process Flow vocabulary; a flow
  is internally still a graph of nodes and wires.)

### Node

A **Node** is the abstract base concept: a single point in the
graph with one or more named inputs (default `'in'`) and one or
more named outputs, with an implementation that turns input ctx
into output and ctx.

Concretely, a Node is **any plain object** with these properties:

- `railKind: string` — the kind identifier; one of `'step'`,
  `'activity'`, `'parallel'`. Future extensions may introduce more
  kinds; the field's mere presence (with a string value) marks the
  object as a Rail-Node.
- `inputs: string[]` — declared input port names.
- `outputs: string[]` — declared output port names.
- `compile()` — validates and prepares the node for execution.
  Idempotent; safe to call multiple times. No-op if already
  compiled.
- `compiled(): boolean` — returns `true` iff the node is currently
  in a valid, ready-to-execute state.
- `invoke(name, ctx, runState)` — **internal** method called by
  the library runner (and by Activity/Parallel-Node implementations
  on their sub-nodes). Not part of the user API; user code does
  not call it. See "Invoke contract" below.

A Node has **no** intrinsic name. Names are assigned when nodes
are placed in a graph (`a.addNode(name, node)`) or held by a flow
(`flow(name, node)`). The `invoke` method receives the
current name as its first argument.

#### Invoke contract

The `invoke` method is the uniform internal interface that every
Rail-Node kind implements. The library runner calls it; Activity
and Parallel-Node implementations call it on their sub-nodes. It
is not a user-facing API, but its contract must hold for any
Node-kind implementation (built-in or future extension):

**Signature.** `invoke(name, ctx, runState)`

- `name: string` — the node's name in the calling context (the
  local name from `addNode`, or the flow's top-level name for
  the root node). Used for logging and trace prefixing.
- `ctx: Object` — the running ctx entering the node.
- `runState` — the internal per-run record (§6.1). Carries step
  counter, current depth, combined cancellation signal, raw
  `killSignal`, logger, top-level flow name. Implementations may
  read and modify it (e.g. increment depth around inner runs).
  Not exposed to step functions; steps see only `runInfo` (§4).

**Return value (success).** Either a value of shape `{ output, ctx? }`
or a `Promise` that resolves to such a value.

- `output: string` — the chosen output port name. Must be an
  element of `node.outputs`.
- `ctx?: Object` — optional. If present, it **replaces** the
  running ctx (no merge). If absent, the running ctx is unchanged.

**Failure.** `invoke` throws (or its returned Promise rejects):

- A `RailRuntimeError` or `RailCompileError` propagates as-is to
  the calling runner.
- Any other thrown value is the caller's responsibility — the
  step-execution-loop runner (§6.2) wraps it into
  `RailRuntimeError(UNHANDLED_THROW)`. Sub-node implementations
  (e.g. an Activity calling its sub-nodes) re-throw without
  wrapping; only the outermost step-execution context performs
  the wrap.

**Preconditions.** `compiled()` must be `true`. Otherwise `invoke`
throws (typically a `RailRuntimeError(INTERNAL)` since it
indicates a Library-level invariant violation).

**Side effects.** `invoke` may mutate `runState` (counter,
depth), call the logger, and recursively invoke sub-nodes. It
does not mutate the input `ctx`.

There is no class hierarchy. Sort identification is by the string
in `railKind`, not by `instanceof`. This makes nodes
cross-realm-safe (multiple loads of `rail.js` produce
indistinguishable nodes) and removes any dependency on JavaScript
class identity.

The library provides three node kinds out of the box, each via a
context-free factory function:

- **Step-Node** (`railKind: 'step'`) — wraps a user-provided
  function. Created by `node(fn, options)`.
- **Activity** (`railKind: 'activity'`) — has internal topology.
  Created by `activity(builderFn)`.
- **Parallel-Node** (`railKind: 'parallel'`) — runs branches
  concurrently. Created by `parallel(branches)`.

Code that needs to discriminate kinds does so by reading
`node.railKind`. Code that needs to recognise "any rail node" does
so by checking `typeof node?.railKind === 'string'` (helper:
`isRailNode`).

### Activity

An **Activity** is a Node (`railKind: 'activity'`) whose
implementation is a graph of named sub-nodes connected by wires.
It has all the standard Node fields plus:

- A single entry endpoint and one or more exit endpoints.
- Zero or more sub-nodes, each known by a name within the
  activity.
- Wires connecting endpoints.
- `toMermaid(name?, opts?)` — Mermaid render of the topology.

The exits — declared via `a.exit(...)` in the builder — appear on
the Node interface as the standard `outputs` array. An activity
does not expose a separate `exits` field; one Node interface,
exits *are* outputs.

Because an Activity *is* a Node, it can be:

- Held by a flow for top-level execution.
- Added as a sub-activity inside another activity, via
  `a.addNode('subname', innerActivity)`.

`Activity.compile()` validates the graph (three phases — see §7),
recursively compiles sub-nodes (whether `'step'`, `'activity'`,
or `'parallel'`) by calling their `compile()` if `compiled()` is
false, and builds the runtime adjacency lookup.
`Activity.compiled()` reflects whether validation has succeeded
since the last modification. `Activity.invoke(name, ctx, runState)`
walks the graph, executing sub-nodes, until an exit is reached or
an error propagates.

### Flow (top-level wrapper)

A **Flow** is the **runtime wrapper**. It is the only object
that allocates and manages run-state. It holds exactly one Node —
the top-level — together with a top-level name, and provides the
top-level execution API. It is *not* a Node; it does not have
`railKind`, `compile()`, or `invoke()`. It is created with the
factory `flow(name, node)` (lowercase, no `new`).

A flow object has:

- `name: string` — the top-level name, used for logging and
  diagnostics.
- `node` — the held node.
- **`run(ctx, opts)`** — allocates a fresh run-state from `opts`,
  invokes the held node with the top-level name, and returns the
  `RunResult`. The held node must be `compiled()`; otherwise
  `run` throws.
- **`toMermaid(opts)`** — Mermaid render of the held node (§3.6,
  §3.11).

The flow is **stateless**: all run-time data lives in the
closure of `run(...)`. The same flow object can be invoked
many times, including concurrently — each `run(...)` is fully
independent. There is no internal "is-running" flag; the design
removes any need for one.

`run(...)` is the only place where `opts` (logger, tracer,
signals, maxSteps) are accepted. Sub-activities, when reached
during execution, share the outer flow's counter, signals,
logger, and tracer (see §6.1 for the run-state's shared vs
per-fork slots).

```js
const def = activity((a) => { /* ... */ });
def.compile();
const sendMessageFlow = flow('sendMessage', def);
const result = await sendMessageFlow.run(ctx, opts);
```

### Endpoint handle

An **endpoint handle** is a value that identifies a connection
point inside an activity for use in `wire(...)` calls. Handles are
returned by builder methods (`a.entry(...)`, `a.exit(...)`,
`a.addNode(...)`) and by node-handle methods (`.out(name)`). They
are opaque to user code.

There is one handle for each entry, exit, and node-port in the
activity. The library guarantees handle identity within a single
builder session: re-declaring an entry/exit/node with the same
name is a compile error, not a duplicate handle.

### Wire

A **wire** is a connection from a source endpoint handle (output
side) to a target endpoint handle (input side).

### Run-state

The **run-state** is the per-run record holding the step counter,
signal plumbing, and logger. It is allocated once by
`flow.run(...)` and shared with every node invoked during the
run, including sub-activities and parallel branches. It is
internal — not part of the public API and not visible to step
implementations.

When the runner is about to execute a step, it constructs a
**run-info** object — the step-visible projection of the
run-state — and passes it to the step as a second parameter. In
v1, run-info contains only `signal`. See §4 for the contract and
§6 for runtime mechanics.

---

## 3. Public API

All exports come from a single module `rail.js`.

Public symbols:

- Node factories: `node`, `activity`, `parallel`.
- Helpers: `merge` (step-return wrapper).
- Runtime: `flow`.
- Errors: `RailCompileError`, `RailRuntimeError`, `RailBuildError`.
- Typed-ctx helpers: `exceptionCtx`, `isExceptionCtx`,
  `isParallelCtx`, `ctxType` (see §3.12).
- Utility: `isRailNode`.

### 3.1 Defining an activity

```js
import { activity, node, flow } from './rail.js';

const sendMessage = activity((a) => {
  const start   = a.entry('in');
  const success = a.exit('success');
  const failure = a.exit('failure');

  const validate = a.addNode('validate',
    node(validateFn, { outputs: ['ok', 'invalid'] }));
  const encrypt  = a.addNode('encrypt',
    node(encryptFn, { outputs: ['ok', 'noKeys'] }));
  const send     = a.addNode('send',
    node(sendFn, { outputs: ['ok', 'net5xx', 'net4xx'] }));

  a.wire(start,                   validate);
  a.wire(validate.out('ok'),      encrypt);
  a.wire(validate.out('invalid'), failure);
  a.wire(encrypt.out('ok'),       send);
  a.wire(encrypt.out('noKeys'),   failure);
  a.wire(send.out('ok'),          success);
  a.wire(send.out('net5xx'),      failure);
  a.wire(send.out('net4xx'),      failure);
});

// `sendFn` handles its own exceptions, mapping them to outputs:
async function sendFn(ctx) {
  try {
    await fetch(ctx.url, { body: ctx.body });
    return 'ok';
  } catch (e) {
    if (e.name === 'NetworkError') return 'net5xx';
    return 'net4xx';
  }
}

sendMessage.compile();
const sendMessageFlow = flow('sendMessage', sendMessage);
const result = await sendMessageFlow.run({ roomId: 'r1', body: 'hi' });
```

`activity(builderFn)`:

- `builderFn` is a synchronous function `(a) => void`. The library
  passes a fresh builder `a` to it. The builder accumulates the
  activity's declarations as the function runs. After the function
  returns, the activity is sealed (no further mutation in v1).
- `activity(...)` returns an Activity (railKind `'activity'`) in
  the **uncompiled** state. Call `.compile()` to validate it and
  prepare it for execution; `.compiled()` returns `false` until
  `.compile()` has succeeded.

There is no name parameter on `activity(...)`. Names belong to
use sites: the `flow(...)` factory for top-level execution, or
`a.addNode(name, ...)` for sub-activity placement.

### 3.2 `node(fn, options)`

Creates a Step-Node from a user function.

```js
import { node } from './rail.js';

const validate = node(validateFn, { outputs: ['ok', 'invalid'] });
```

Parameters:

- `fn` — a step function
  `(ctx, runInfo?) => StepReturn | Promise<StepReturn>` (§4).
  Steps that don't need run-info can omit the second parameter.
- `options.inputs?: string[]` — default `['in']`. Declaring more
  than one input gives the step multiple distinct entry ports.
  The runner exposes the activated port to the step as
  `runInfo.input` (see §4), so the step can branch on which
  upstream path activated it. Wires target individual inputs via
  `nodeHandle.in('portName')` (see §3.4).
- `options.outputs: string[]` — required, non-empty, no duplicates.

Returns a Step-Node (railKind `'step'`) with the configured
inputs and outputs. The node has no intrinsic name; one is
assigned when it is added to an activity via
`a.addNode(name, node)` or to a flow via
`flow(name, node)`.

In normal usage, step-nodes are created inline at the point of
use:

```js
const v = a.addNode('validate',
  node(validateFn, { outputs: ['ok', 'invalid'] }));
```

For reuse, the step-node can be assigned to a variable and
referenced from multiple `addNode` calls or activities:

```js
const validateNode = node(validateFn, { outputs: ['ok', 'invalid'] });

activity((a) => {
  a.addNode('first',  validateNode);
  a.addNode('second', validateNode);   // same node, different name
});
```

### 3.3 Builder methods

All builder methods return endpoint handles (where applicable).
The returned handle is the only way to reference the declared
element in later `wire(...)` calls.

- **`a.entry(name)`** — declares the activity's single entry.
  Returns an entry handle. Calling twice produces a compile error
  `MULTIPLE_ENTRIES`.
- **`a.exit(name)`** — declares an exit. Returns an exit handle.
- **`a.standardExits()`** — convenience: declares `'success'` and
  `'failure'` exits. Returns `{ success, failure }`. Pure
  shorthand — no other behaviour is implied. The names `'success'`
  and `'failure'` are conventional but carry no library semantics.
- **`a.addNode(name, node)`** — adds a Rail-Node to the activity
  under the given local name. `node` must satisfy `isRailNode(...)`
  — a Step-Node (from `node(...)`), an Activity (from
  `activity(...)`), or a Parallel-Node (from `parallel(...)`).
  Returns a **node handle** (see §3.4).

  `addNode` does not accept raw functions or option objects. All
  node configuration (inputs, outputs) belongs to the node itself,
  not to its placement. To add a step-function inline, wrap it:
  `a.addNode('name', node(fn, opts))`.

  The same node instance may be added under multiple names, in the
  same activity or in different activities. Each add yields a
  separate handle; they share the same compiled implementation.

- **`a.wire(source, target)`** — declares a wire from source
  handle to target handle. Performs structural checks
  synchronously, throwing `RailBuildError` on failure:
  - `INVALID_WIRE_DIRECTION` — `source` is not usable as a wire
    source (e.g. it's an exit, or an input port handle), or
    `target` is not usable as a wire target (e.g. it's an entry,
    or an output port handle).
  - `AMBIGUOUS_NODE_INPUT` — `target` is a node handle, but the
    node has multiple inputs; use `nodeHandle.in('portName')`
    instead.
  - `WIRE_FROM_OTHER_BUILDER` — one of the handles was returned
    by a different activity's builder.

  These checks happen at the wire-call site so the stack trace
  points directly to the offending line. Other validation
  (reachability, completeness, topology) waits for `compile()`.

There are no separate `a.node(...)`, `a.activity(...)`, or
`a.parallel(...)` builder methods. Construction (the factories)
and placement (`addNode`) are kept distinct.

### 3.4 Node handles

A node handle, returned by `a.addNode(...)`, has the following
shape:

```js
{
  // --- direct use as wire endpoint (input side) ---
  // The handle itself is the input endpoint of the node.
  // Pass it directly to a.wire(..., nodeHandle).

  out: (port: string) => OutputHandle,
  in:  (port: string) => InputHandle,    // for nodes with multiple inputs
}
```

- Use the handle directly as a `wire(...)` target to refer to the
  node's (single) input. If the node has multiple inputs, this is
  a synchronous `RailBuildError(AMBIGUOUS_NODE_INPUT)` at the
  `wire(...)` call site; use `.in(name)` instead.
- Use `.out(port)` to refer to a specific output. If `port` is not
  in the node's declared outputs, `.out(...)` throws synchronously
  with `RailBuildError(UNKNOWN_PORT)`.
- Use `.in(port)` to refer to a specific input on multi-input
  nodes. Unknown port names raise `RailBuildError(UNKNOWN_PORT)`
  synchronously, the same as `.out(...)`. At runtime, the step
  receives the activated port name as `runInfo.input` (§4).

Entry and exit handles have analogous behaviour: an entry handle
is used as a wire **source**, an exit handle as a wire **target**.
Using them in the wrong direction raises
`RailBuildError(INVALID_WIRE_DIRECTION)` synchronously at the
`wire(...)` call site.

### 3.5 Activity API (post-builder)

After the `activity(...)` call returns, the Activity object
exposes:

```js
{
  railKind:   'activity',
  inputs:     string[],         // typically ['in']
  outputs:    string[],         // declared exit names, in declaration order
  compile():  void,             // validate + recursively compile sub-nodes
  compiled(): boolean,
  invoke(name, ctx, runState):  // internal; called by the library runner.
                                // Returns { output, ctx? } per the
                                // invoke contract (§2). For an Activity,
                                // `output` is the name of the exit reached.
                                // Throws on uncompiled state or runtime error.
  toMermaid(name?, opts?): string,
}
```

The `outputs` array contains the activity's exit names. From
inside the builder these are called *exits* (declared via
`a.exit(...)`); on the Node interface they appear as `outputs`,
identical to any other node kind. There is no separate `exits`
field — `outputs` is the single source of truth.

An Activity does **not** have `.run()`. Top-level execution goes
through a flow (§3.6).

In v1, the activity is sealed after the builder closure returns;
there is no API to add or remove nodes after construction.
`compiled()` flips from false to true on successful `compile()`
and stays true. The model permits future editing APIs that would
flip `compiled()` back to false on mutation — this spec is
forward-compatible with that, but does not introduce them.

`toMermaid()` accepts an optional `name` argument used for
labelling in the rendered diagram, plus optional rendering
options. When a name is omitted, a placeholder like
`'<anonymous>'` is used.

### 3.6 `flow(name, node)`

```js
import { flow } from './rail.js';

const sendMessageFlow = flow('sendMessage', sendMessage);
const result = await sendMessageFlow.run(ctx, opts);
```

`flow(name, node)` is a factory function (not a class). It
returns a plain object with `name`, `node`, `run`, and
`toMermaid` properties. There is no `new` keyword and no class
hierarchy — consistent with the other factories (`node(...)`,
`activity(...)`, `parallel(...)`, `catching(...)`).

A **flow** is the runtime wrapper around a top-level node. The
term comes from BPMN's Sequence Flow / Process Flow vocabulary;
internally a flow is still a directed graph of nodes connected
by wires (see §2 Conceptual Model), but the term "flow" reflects
the workflow-orientation of the library and disambiguates from
the abstract graph data structure.

- `name: string` — the top-level diagnostic name. Used by the
  default logger and in error messages. Must be a non-empty
  string; otherwise `RailBuildError(INVALID_FLOW_NAME)`.
- `node` — must be a Rail-Node (`isRailNode(node)`). Typically an
  Activity, but a Step-Node or Parallel-Node also work.
- If `node` is not a Rail-Node, the factory throws
  `RailBuildError(NOT_A_NODE)`.
- If `node.compiled()` is false, the factory throws
  `RailBuildError(NODE_NOT_COMPILED)`.
- The flow holds the node by reference and does not modify it.

The flow object is **stateless**: it carries no run-time data of
its own. All run-state is allocated inside `run(...)` and lives
only in that invocation's closure. The same flow object can
therefore be invoked many times, including concurrently — each
`run(...)` is fully independent. This also means that a tracer
(§6.8) can start new runs of any flow (the same one or a
different one) during event handling without any conflict with
the run that emitted the event.

`flow.run(ctx, opts)`:

- Allocates a fresh run-state from `opts` (see §6.1).
- Invokes `node.invoke(name, ctx, runState)`, where `name` is the
  flow's top-level name. The invoke returns `{ output, ctx? }`
  (§2 invoke contract).
- Maps that result into a `RunResult`: the `output` becomes the
  `terminus`, the `ctx` becomes the final ctx (or the input ctx
  if `invoke` returned no ctx field), and the trace assembled
  during the run is attached.

```js
{
  ctx:      Object,         // final ctx after the run
  trace:    TraceEntry[],   // ordered list of step executions
  terminus: string,         // the output produced by the top-level node
                            // (for an Activity, an exit name; for a
                            // top-level Step-Node, a declared output;
                            // for a top-level Parallel-Node, 'done')
}
```

The term "terminus" is **caller-facing**: it's the name a caller
sees on a `RunResult`. Internally the library calls everything
"output" (the value an `invoke` returns); only at the
flow.run boundary does the final output become the terminus.

The library has no built-in notion of "success" or "failure" for
a `RunResult`. Reaching an exit is by definition a successful run
— what the exit *means* is a domain question that the caller
answers by inspecting `terminus`. The dichotomy at the API
boundary is simpler:

- **Promise resolves** with a `RunResult` → the run reached an
  exit. The terminus says which.
- **Promise rejects** with a `RailRuntimeError` → a library-level
  failure. The error carries the trace and ctx for debugging.

If a `RailRuntimeError` is raised during execution, it propagates
out of `run(...)` directly; no `RunResult` is returned. The
error itself carries the trace and ctx for debugging (§5).

To detect whether the run's final ctx is an exception context
(the result of a step using `exceptionCtx(...)` whose path
ultimately reached an exit), check `isExceptionCtx(result.ctx)` —
see §3.12.

`flow.toMermaid(opts?)`:

- Returns a Mermaid `flowchart LR` string of the held node, using
  the flow's top-level name as the diagram's label.
- For Activity nodes, this delegates to
  `node.toMermaid(flow.name, opts)`.
- For Step-Nodes and Parallel-Nodes, it produces a minimal
  diagram: an entry, the node itself, and one exit per declared
  output. Useful for top-level Step-Nodes (§9.7) and for visual
  introspection during testing.
- See §3.11 for rendering details.

```js
TraceEntry = {
  step:     string,         // node name (or dotted path for sub-activity steps; see §8)
  output:   string | null,  // output port produced; null if the step threw
  duration: number,         // milliseconds, rounded to 2 decimals
  depth:    number,         // sub-activity nesting depth; see §6.2 / §8
  threw:    boolean,        // true if the step threw an exception
  error?:   Error,          // present iff threw is true
}
```

The `depth` field counts the number of sub-activity nestings the
step is executed within. Top-level steps have `depth: 0`; steps
inside a one-level sub-activity have `depth: 1`; doubly nested
have `depth: 2`. Parallel-Nodes do not themselves contribute to
depth — but Activities used as branches do (they are normal
sub-activities). The compound entry that summarises a
sub-activity's execution carries the depth of the *outer* (the
caller), not the inner. See §8.4 for trace-embedding details.

### 3.7 `parallel(branches)`

Creates a Parallel-Node (railKind `'parallel'`) that runs branches
concurrently.

```js
import { activity, node, parallel } from './rail.js';

const parallelLoad = parallel({
  profile: profileActivity,    // an activity (must be a Rail-Node)
  keys:    keysActivity,
  audit:   node(auditFn, { outputs: ['done'] }),    // or a step-node
});

const wf = activity((a) => {
  const start = a.entry('in');
  const ok    = a.exit('ok');
  const fail  = a.exit('failed');

  const fan      = a.addNode('parallel', parallelLoad);
  const evaluate = a.addNode('evaluate',
    node(evaluateFn, { outputs: ['ok', 'failed'] }));

  a.wire(start,                fan);
  a.wire(fan.out('done'),      evaluate);
  a.wire(evaluate.out('ok'),     ok);
  a.wire(evaluate.out('failed'), fail);
});
```

Parameters:

- `branches`: object whose keys are branch names and whose values
  are Rail-Nodes (Step-Node, Activity, or another Parallel-Node).
  Plain step functions are not accepted directly — wrap them with
  `node(...)` if needed.

Properties of the returned Parallel-Node:

- `railKind: 'parallel'`.
- `outputs: ['done']` — fixed.
- `inputs: ['in']` — fixed.
- `compile()` — validates the branches map, then recursively calls
  `branch.compile()` on each branch whose `compiled()` is false.
  Errors raised during sub-compile are nested into a
  `RailCompileError` with a path hint identifying the branch.
- `invoke(name, ctx, runState)` — runs the branches via
  `Promise.allSettled`. Each branch receives the input ctx **by
  reference**; per the immutability contract (§4), branches do
  not mutate the ctx, so sharing is safe. Each branch also
  receives its own **fork** of the run-state (§6.1) — per-fork
  slots like `depth` and `currentInput` are independent per
  branch, while the `shared` sub-object (counter, signals,
  logger, tracer, flow name, maxSteps) is held by reference
  and visible to all branches. Without per-branch forks,
  interleaved `await`s between branches would trample each
  other's `depth` and `currentInput`, leading to wrong values
  in trace entries and tracer events. Returns
  `{ output: 'done', ctx: <parallel-results-ctx> }` per the
  invoke contract (§2). On branch-level failure (a
  `RailRuntimeError` propagating out of any branch), `invoke`
  awaits all siblings via `allSettled`, then re-throws the first
  error in **branch declaration order** (deterministic across
  runs). Errors from siblings are **not** aggregated — only the
  first branch's error object is exposed to the caller. Trace
  entries from all branches up to their respective failure
  points remain in the shared trace, so the run history is
  preserved even though the sibling error objects themselves are
  discarded. If multi-error correlation matters, branches should
  catch internally and emit a structured ctx that downstream
  evaluators can inspect.

Output is always `'done'`. The ctx returned by `invoke` (and
becoming the new running ctx in the outer flow) has the form:

```js
{
  __type:   'parallel-results',
  inputCtx: <the ctx that entered the parallel node>,
  results: {
    profile: { terminus: string, ctx: Object },
    keys:    { terminus: string, ctx: Object },
    audit:   { terminus: string, ctx: Object },
  }
}
```

Each branch's entry in `results` carries a `terminus` (the
caller-facing name for "where the branch ended") and the final
`ctx` of that branch.

The `__type: 'parallel-results'` marker follows the typed-ctx
convention in §3.12. Use `isParallelCtx(ctx)` to detect this
shape.

For each branch, `terminus` is the exit name reached (for
Activities) or the output name returned (for Step-Nodes); `ctx`
is the final ctx of that branch (replace semantics).

This form intentionally does **not** merge branch results back
into the running ctx. The expected usage pattern is to follow a
parallel node with an evaluation node that consumes `inputCtx`
and `results` and produces a normal pipeline ctx with a meaningful
output. See §9.5.

If a branch raises a `RailRuntimeError` or `RailCompileError`
during execution, the parallel node activates an internal abort
(linked into the combined cancellation signal of all sibling
branches, exposed to their steps as `runInfo.signal`), waits for
`Promise.allSettled`, then re-throws the original error.

Because Parallel-Nodes are full-fledged Rail-Nodes, the recursive
compile during the outer activity's `compile()` reaches them and
their branches. Branch-level structural errors thus surface at
outer-compile time, not at runtime.

### 3.8 `merge(stepFn)` — convenience wrapper

```js
import { merge } from './rail.js';
```

`merge(stepFn)` wraps a step that returns only the *patch* it
wants to add to the ctx, rather than a full replacement. The
wrapper spreads the input ctx around the patch.

```js
// Without merge:
async function validateA(ctx) {
  return { output: 'ok', ctx: { ...ctx, validatedAt: Date.now() } };
}

// With merge:
const validateB = merge(async (ctx) => ({
  output: 'ok',
  patch: { validatedAt: Date.now() },
}));
```

The wrapped step's return shape is:

```
MergeStepReturn =
  | string                              // forwarded as-is, no ctx change
  | { output: string,
      patch?: Object }                  // shallow-merged into the input ctx
```

`merge(stepFn)` returns a step function (not a Step-Node). It is
intended to be passed as the `fn` argument to `node(...)`:

```js
const v = a.addNode('validate', node(merge(stepFn), { outputs: [...] }));
```

### 3.9 `isRailNode(value): boolean`

Utility for external code that needs to detect Rail-Nodes:

```js
isRailNode(value) === (typeof value?.railKind === 'string')
```

Useful when extending the library, writing tests, or building
introspection tools.

### 3.10 No external endpoint helpers

There are **no** free `entry()`, `node()`-as-handle, `exit()`
constructors. All endpoints come from builder methods. (`node(...)`
as a Step-Node factory is unrelated — it produces nodes, not
endpoint handles.) This is a deliberate design choice: it
eliminates string-based references that can become stale under
refactoring, and lets the builder catch typos early
(`.out('okk')` throws synchronously rather than failing at
compile).

### 3.11 Mermaid render

There are two entry points for Mermaid output:

- **`flow.toMermaid(opts?)`** — convenient when you have a flow;
  uses the flow's top-level name as the label. See §3.6.
- **`activity.toMermaid(name?, opts?)`** — directly on an
  Activity. The `name` argument labels the rendered activity; if
  omitted, the diagram uses `'<anonymous>'`. Useful for unit-tests
  or introspection without constructing a flow.

Both produce a `flowchart LR` string with the same conventions:

- Entry rendered as `start([entry-name])`.
- Each node rendered as a rectangle: `nodeId["node-name"]`.
- Sub-activity nodes rendered as subroutine shape `[[name]]` with
  class `subActivity`. Not expanded inline (see §13).
- Parallel-Nodes rendered with a special parallel marker and class
  `parallelNode`. Not expanded inline.
- Each exit rendered as `endExit_name([exit-name])` with class
  `exit`. The library does not privilege any specific exit name
  (such as `'success'`); a renderer that wants distinct styling
  per terminus can add classes afterwards based on the activity's
  `outputs`.
- Each wire becomes an edge labeled with the source's output port
  name (or unlabeled for the entry wire).

#### Rendering non-Activity Top-Level Nodes

When a flow holds a Step-Node or Parallel-Node as its top-level
(see §9.7), `flow.toMermaid()` produces a minimal diagram:

- A synthetic entry `start([in])`.
- The held node rendered with its standard shape.
- One synthetic exit per declared output, named
  `endExit_<output>([<output>])` with class `exit`.
- A solid edge from the entry to the node, and one labelled edge
  per output to its corresponding exit.

This makes top-level Step-Nodes and Parallel-Nodes visually
inspectable without wrapping them in an Activity.

There are no implicit edges from `throws` mechanics: the library
has no `throws` mechanism (§4.1). Steps that want to convert
caught exceptions into outputs do so explicitly inside their own
`try`/`catch`, producing normal output names. Those outputs are
rendered as ordinary solid edges, like any other.

Options accepted by `toMermaid()`:

- `direction?: 'LR' | 'TB'` — flowchart direction. Default `'LR'`.

### 3.12 Typed ctx helpers

The library introduces a lightweight convention for **typed
contexts**: a ctx object carrying a `__type: '<name>'` field
declares its shape. The library uses this convention for two of
its own constructs:

- `__type: 'exception'` — produced by user code calling
  `exceptionCtx(err, inputCtx)` after catching an exception in a
  step (see §9.7).
- `__type: 'parallel-results'` — produced by `parallel(...)`
  (§3.7).

The convention is open: user code can introduce its own
`__type: '<custom>'` strings in step return values to mark
structured contexts that downstream nodes should recognise. The
library does not validate `__type` strings, does not reserve a
namespace, and does not require this convention — it merely uses
it consistently for its own constructs and provides helpers.

#### Constructors and helpers

```js
import {
  exceptionCtx,
  isExceptionCtx,
  isParallelCtx,
  ctxType,
} from './rail.js';
```

- **`exceptionCtx(err, inputCtx)`** — constructs an exception
  context. Returns:

  ```js
  {
    __type:   'exception',
    inputCtx: <inputCtx>,
    error:    <err>,
  }
  ```

  The library does not produce exception ctx values itself —
  there is no `throws`-mapping mechanism. Steps that want to
  convert a caught exception into a downstream-recognisable form
  use `exceptionCtx(...)`:

  ```js
  async function risky(ctx) {
    try {
      const r = await dangerousOp(ctx);
      return { output: 'ok', ctx: { ...ctx, result: r } };
    } catch (e) {
      return { output: 'failed', ctx: exceptionCtx(e, ctx) };
    }
  }
  ```

  The constructor accepts any value for `err`, including `Error`
  instances and synthesised error-like objects (`new Error('no
  keys')`). It does **not** wrap or transform the error value.

  Both `inputCtx` and `error` are stored **by reference** — no
  cloning. Per §4 the step must not mutate the ctx; if user code
  violates that contract, the `inputCtx` reference will reflect
  the mutation. The `error` reference is held as-is; downstream
  consumers should treat it as read-only.

- **`isExceptionCtx(value): boolean`** — `value?.__type === 'exception'`.

- **`isParallelCtx(value): boolean`** — `value?.__type === 'parallel-results'`.

- **`ctxType(value): string | undefined`** — generic accessor.
  Returns `value?.__type` if it is a string, else `undefined`.
  Useful for `switch` over `__type` or for diagnostics.

The specific `is*Ctx` helpers and the generic `ctxType` are both
available; specific helpers are convenience for common cases,
`ctxType` is for code that handles multiple ctx shapes uniformly.

There is no generic `typedCtx(type, body)` constructor in v1. User
code that needs a custom typed ctx writes the object literal
directly:

```js
return { output: 'received', ctx: { __type: 'incoming', ...payload } };
```

A `parallelResultCtx(...)` helper is also not provided in v1 —
the parallel node constructs the ctx itself, and downstream code
uses `isParallelCtx` to detect it.

#### When user code should use these helpers

- **Step that catches an exception and wants downstream code to
  treat the failure uniformly:** use `exceptionCtx(e, ctx)` in the
  failure-output ctx. Downstream code uses `isExceptionCtx` to
  branch.
- **Step that emits a structured "non-throw" failure:** also use
  `exceptionCtx`, with a synthesised `Error` as `err`. The
  downstream contract (`isExceptionCtx` succeeds, `error` field is
  present) is the same. The convention is by *content*, not by
  *origin*.
- **Step or evaluator after `parallel`:** check `isParallelCtx`,
  destructure `inputCtx` and `results`, decide the next output.

### 3.13 `catching(stepNode, mapping)` — exception-to-output wrapper

Many step implementations call third-party code (`fetch`,
`JSON.parse`, library APIs) that throws on failure. Without a
helper, every such step needs a hand-written `try`/`catch` block
that maps error names to output names — repetitive boilerplate
that obscures the real logic. `catching(...)` is a Library helper
that produces a new Step-Node from an existing one, adding the
exception-to-output translation declaratively.

```js
import { catching, node } from './rail.js';

const send = a.addNode('send', catching(
  node(sendFn, { outputs: ['ok'] }),
  {
    NetworkError: 'net5xx',
    AbortError:   'cancelled',
  }
));
// Resulting node has outputs ['ok', 'net5xx', 'cancelled'].
```

**Signature.** `catching(stepNode, mapping)`

- `stepNode`: a Step-Node (`railKind: 'step'`). In v1, only
  Step-Nodes are accepted as input. Passing an Activity or
  Parallel-Node raises `RailBuildError(CATCHING_REQUIRES_STEP)`
  synchronously.
- `mapping`: an object `{ <ErrorName>: <outputName>, ... }`. Keys
  are matched against `e.name` of thrown values. Values are
  output names that the wrapper should produce instead of letting
  the exception propagate.

**Returns.** A new Step-Node with:

- `inputs` identical to `stepNode.inputs`.
- `outputs` = `stepNode.outputs ∪ Object.values(mapping)`,
  deduplicated, in deterministic order (original outputs first,
  in their declared order; new mapping targets next, in mapping
  insertion order).
- An `invoke(name, ctx, runState)` that runs `stepNode.invoke(...)`
  and, on a thrown exception, first checks the error class:
  - **`RailRuntimeError` and `RailCompileError` are never
    mapped.** They propagate unchanged, even if the mapping
    contains a key like `'RailRuntimeError'`. These are
    library-level errors, not domain failures, and the wrapper
    must not convert them into outputs.
  - For any other thrown value, looks up `e.name` in `mapping`:
    - If present, returns `{ output: <mapped> }`. The running
      ctx is preserved (no ctx replacement from the wrapper
      itself).
    - If absent, re-throws. The runner classifies and wraps as
      for any uncaught throw (§6.4), typically becoming
      `RailRuntimeError(UNHANDLED_THROW)`.

**`compile()` and `compiled()`** delegate to `stepNode`. The
wrapper holds a reference; compiling the wrapper compiles the
inner step exactly once (idempotent, §7).

**Library-runtime perspective.** The result is a normal Step-Node;
the runtime does not know it was produced by `catching`. There is
no library-internal "throws-mapping" mechanism (§4.1) — the
wrapping happens at construction time, materialising as a regular
`try`/`catch` inside the wrapper's invoke. In the Mermaid render,
the wrapper appears as a single rectangle node with the extended
`outputs` as outgoing edges. There is no second visual node and
no dotted edges.

**No catch-all.** `mapping` keys are explicit error names. There
is no `default` key, no `'*'`. Errors not in the mapping
propagate as graph errors (§4.1). Programmers who genuinely want
to catch every exception write the `try`/`catch` themselves and
use `exceptionCtx(...)` — a deliberate, explicit choice.

**Composition.** `catching(...)` returns a Step-Node, so it is
assignable, addable, and reusable like any other:

```js
const baseSend = node(sendFn, { outputs: ['ok'] });

const sendInRoom = catching(baseSend, { NetworkError: 'roomFailure' });
const sendInDM   = catching(baseSend, { NetworkError: 'dmFailure' });
// baseSend is shared and compiled exactly once.
```

The shared inner step is compiled once and reused; only the
catch-mapping differs per wrapper.

---

## 4. Step contract

A step is a function
`(ctx, runInfo = {}) => StepReturn | Promise<StepReturn>` where:

```
StepReturn =
  | string                                  // shorthand: produces this output, ctx unchanged
  | { output: string,
      ctx?: Object }                        // if `ctx` is present, replaces the running ctx;
                                            // if absent, the running ctx is unchanged
```

The second parameter is the **run-info** object. It is supplied
by the runner with information from the current run that is not
domain data. Steps that don't need it can omit the parameter
entirely:

```js
async function plain(ctx) { /* ... */ }                  // OK
async function aware(ctx, runInfo) { /* ... */ }         // OK
```

The `runInfo = {}` default in the formal signature ensures that
a step called by hand without the second argument behaves
correctly.

In v1, `RunInfo` has the following shape:

```
RunInfo = {
  signal?: AbortSignal,    // cooperative cancellation; see §6.7
  input:   string,         // input port through which this step was activated
}
```

`runInfo.signal`, when present, is the combined cancellation
signal (see §6.7) that aborts on `opts.signal` or
`opts.killSignal` if either is supplied. Steps that perform
abortable I/O should pass it through:

```js
async function fetchPayload(ctx, runInfo) {
  const res = await fetch(ctx.url, { signal: runInfo.signal });
  return { output: 'ok', ctx: { ...ctx, payload: await res.json() } };
}
```

`runInfo.input` is the name of the input port through which the
step was activated. For single-input steps (the default
`inputs: ['in']`), this is always `'in'` — steps that don't care
can simply ignore the field. For multi-input steps, the field
identifies which entry path activated the step:

```js
async function recover(ctx, runInfo) {
  switch (runInfo.input) {
    case 'retry': return { output: 'ok',   ctx: { ...ctx, retried: true } };
    case 'skip':  return { output: 'ok',   ctx: { ...ctx, skipped: true } };
    default:      return 'ok';
  }
}

// Wired with `inputs: ['retry', 'skip']` on the node.
```

The library always sets `runInfo.input`. For a top-level
Step-Node held directly by a flow (§9.7), the activated port is
the first declared input — typically `'in'`. This is consistent
with the synthetic `start([in])` entry shown in `flow.toMermaid()`
for non-Activity top-level nodes (§3.11).

`RunInfo` is a stable contract: future versions may add new
fields (e.g. the name of the previous output, a read-only view
of the trace), but no field will be removed. Steps that ignore
`runInfo` continue to work without change.

**Rules:**

- The returned `output` **must** be one of the outputs declared
  for the node. Otherwise:
  `RailRuntimeError(UNKNOWN_OUTPUT_AT_RUNTIME)` (see §5).
- If `ctx` is present in the return, it **replaces** the running
  ctx. The library does not merge. Steps that want to preserve
  existing fields must spread the input ctx explicitly:
  `ctx: { ...ctx, foo: bar }`.
- If `ctx` is absent (string-form, or object without a `ctx`
  field), the running ctx is unchanged. `return 'ok'` is exactly
  equivalent to `return { output: 'ok' }`.
- **Reusable steps should always spread the input ctx when they
  return one.** A step that returns a `ctx` object without
  spreading silently drops every field it does not know about — it
  works in the workflow it was written for and breaks in any
  other.
- A step **must not throw a domain error**; failure modes are
  expressed as named outputs (§4.1). A step that throws causes
  `RailRuntimeError(UNHANDLED_THROW)` and aborts the run.
- `ctx` is treated as immutable from the step's perspective. Steps
  must not mutate the input ctx; they construct and return a new
  ctx instead (or omit `ctx` from the return).

### 4.1 No exception-based control flow

The library does **not** offer a `throws`-mapping mechanism. There
is no node-local `throws` option, no activity-level
`a.throws(...)` declaration, no implicit catch-all. Failure modes
are expressed exclusively as named outputs.

This is a deliberate design choice: control flow over exceptions
is opaque, breaks topology, and invites programmers to skip
modelling failure as part of the graph. The library prefers
explicit wires.

**For steps that interact with code that throws** (e.g.
third-party libraries, `fetch`, `JSON.parse`), the recommended
pattern is `try`/`catch` *inside the step*, producing a named
output:

```js
node(async (ctx) => {
  try {
    const r = await fetch(ctx.url);
    return { output: 'ok', ctx: { ...ctx, response: r } };
  } catch (e) {
    if (e.name === 'NetworkError') return 'net5xx';
    if (e.name === 'AbortError')   return 'cancelled';
    throw e;        // unrelated bug — propagate as graph error
  }
}, { outputs: ['ok', 'net5xx', 'cancelled'] })
```

The step itself decides which exceptions are "expected and mapped"
and which are bugs to propagate. Exceptions that propagate become
graph errors (`UNHANDLED_THROW`) and abort the run; the caller
catches them with `try`/`catch` around `flow.run(...)`.

**For steps that want to forward the caught exception as
structured data** to a downstream evaluator, use `exceptionCtx(...)`
(§3.12, §9.7):

```js
node(async (ctx) => {
  try {
    const r = await dangerousOp(ctx);
    return { output: 'ok', ctx: { ...ctx, result: r } };
  } catch (e) {
    return { output: 'failed', ctx: exceptionCtx(e, ctx) };
  }
}, { outputs: ['ok', 'failed'] })
```

The next node downstream of `'failed'` consumes a typed exception
ctx and decides how to recover. The graph topology shows this
explicitly as a wire from `'failed'` to the recovery node — no
hidden dotted edge.

**The principle:** the topology a reader sees in the Mermaid
render is *the actual control flow*. There are no invisible
edges, no implicit failure paths, no "if anything goes wrong, jump
here." Every transition is a wire.

### 4.2 ctx is owned by the programmer

The running ctx is the programmer's domain object. The library
**does not write to it** — it never injects fields, never
overwrites supplied values, never reserves names for its own
use. Library-side information that steps may need (currently
just the cancellation signal) is delivered via the separate
`runInfo` parameter (§4), keeping the ctx clean.

There is one **convention** the library follows when producing
ctx values, and which user code may follow too:

- **`__type`** — string marker for typed contexts. The library
  uses two values internally: `'exception'` (in
  `exceptionCtx(...)`, §3.12) and `'parallel-results'` (when a
  parallel node finishes, §3.7). User code may introduce its own
  `__type` strings to mark structured contexts that downstream
  nodes recognise. See §3.12. Steps generally should not write
  `__type` directly — they should use the `exceptionCtx(...)`
  helper, the parallel node's automatic output, or write their
  own typed-ctx literal with their own `__type` value.

The convention is informational: it carries no library
enforcement. A ctx without `__type` is a perfectly normal ctx;
the library does not require it.

In particular, **`error` is not reserved**. The library never
writes `ctx.error`. The `exceptionCtx(...)` helper (§3.12)
produces a typed-ctx object whose `error` field sits alongside
`inputCtx` and `__type`, but only when user code calls it. Any
`error` field in a non-typed ctx is the result of step code or
downstream evaluation nodes writing it, not of library mechanics.

---

## 5. Error classes and propagation rules

This section is normative.

### 5.1 The two classes of errors

**Domain errors.** Expected, business-relevant failures produced
by step implementations. **Always** modelled as named outputs
(`return 'noKeys'`). The graph handles them; the run terminates
normally at one of its exits. The library has no
exception-mapping mechanism (§4.1).

**Graph errors.** Failures of the graph contract or of the library
itself. Examples: a step returns an output name not declared, the
step counter is exceeded, the logger throws, a sub-activity
reference is invalid, an internal lookup is missing. These are
bugs, not outcomes, and they must surface immediately.

### 5.2 The hard rule

> Any thrown exception inside a step propagates out of
> `flow.run(...)` as a `RailRuntimeError(UNHANDLED_THROW)`. The
> library does not catch domain exceptions; failure modes are
> expressed as named outputs only (§4.1).

A `RailRuntimeError` originating in a step (or raised by the
runner itself) is wrapped or re-thrown as appropriate and
propagates out of `run()`. A `RailCompileError` raised inside a
step likewise propagates. Every other thrown value is wrapped
into a `RailRuntimeError(UNHANDLED_THROW)` whose `cause` is the
original error.

### 5.2.1 Success and failure at the API boundary

The library has no built-in notion of "successful" or
"unsuccessful" runs based on terminus name. Reaching any exit is
a successful run from the library's standpoint; what the exit
*means* is a domain question.

The dichotomy is at the JS-idiom layer:

- **Promise resolves** with a `RunResult` → the run reached an
  exit. The terminus says which.
- **Promise rejects** with a `RailRuntimeError` → a library-level
  failure. The error carries the trace and ctx for debugging.

A caller that wants to act on a specific terminus reads
`result.terminus` and compares it to whatever names the activity
declares. There is no `result.ok` shortcut; the library does not
privilege the name `'success'`.

### 5.3 `RailRuntimeError` shape

```js
class RailRuntimeError extends Error {
  name = 'RailRuntimeError';
  code: string;                     // see codes below
  flow: string;                     // top-level flow name
  trace: TraceEntry[];              // trace up to and including the failing step
  ctx: Object;                      // ctx state at failure
  cause?: Error;                    // originally thrown error, if any
}
```

Codes:

| Code                          | When                                                                               |
|-------------------------------|------------------------------------------------------------------------------------|
| `UNKNOWN_OUTPUT_AT_RUNTIME`   | A step returned an output name not declared.                                       |
| `UNHANDLED_THROW`             | A step threw an exception. The library does not catch domain exceptions (§4.1).    |
| `STEP_LIMIT_EXCEEDED`         | The run's step counter exceeded `maxSteps` (default 1000; see §6.5).               |
| `KILLED`                      | The kill switch (`opts.killSignal`) aborted before a node started. See §6.7.       |
| `LOGGER_FAILED`               | The user-provided logger threw.                                                    |
| `TRACER_FAILED`               | The user-provided tracer threw. See §6.8.                                          |
| `INVALID_SUB_NODE`            | A sub-node's invoke produced something invalid.                                    |
| `INTERNAL`                    | A library invariant was violated (defensive code path).                            |

`RailRuntimeError` always propagates out of `flow.run(...)`;
there is no library mechanism that would catch or remap it.

### 5.4 `RailBuildError`

A separate, narrow error class for builder-time and pre-execution
validation:

```js
class RailBuildError extends Error {
  name = 'RailBuildError';
  code: string;
  // additional fields per code
}
```

Codes:

| Code                       | When                                                                                                |
|----------------------------|-----------------------------------------------------------------------------------------------------|
| `UNKNOWN_PORT`             | `nodeHandle.out('xyz')` (or `.in('xyz')`) references a port not declared on the node.               |
| `NOT_A_NODE`               | A non-node value was passed where a Rail-Node was required.                                         |
| `NODE_NOT_COMPILED`        | `flow(name, node)` was called with a node whose `compiled()` is false.                         |
| `INVALID_FLOW_NAME`       | `flow(name, ...)` was called with a non-string or empty name.                                  |
| `INVALID_WIRE_DIRECTION`   | `a.wire(src, tgt)` source is not usable as a source, or target is not usable as a target.           |
| `AMBIGUOUS_NODE_INPUT`     | `a.wire(src, nodeHandle)` where the node has multiple inputs; use `nodeHandle.in('port')` instead.  |
| `WIRE_FROM_OTHER_BUILDER`  | `a.wire(...)` was given a handle returned by a different activity's builder.                        |
| `CATCHING_REQUIRES_STEP`   | `catching(node, mapping)` was called with a node whose `railKind !== 'step'`.                       |

These catch errors at the earliest possible moment — at the
calling line, with a stack trace pointing to it — rather than
during `compile()` or runtime.

### 5.5 No `RunResult` on graph errors

When a `RailRuntimeError` propagates, the caller does **not**
receive a `RunResult`. The error itself carries `trace` and `ctx`
for debugging, but the run did not terminate at an exit.

---

## 6. Runtime semantics

### 6.1 Initial state and run-state

`flow.run(initialCtx, opts)`:

- `initialCtx` defaults to `{}`. The library does **not** clone
  it — `initialCtx` is passed by reference into the run as the
  starting ctx. Within the run, the ctx is passed by reference
  through every step, sub-activity, and parallel branch; steps
  that want to change it return a new object via spread
  (§4). Steps must not mutate the ctx (§4); if they do, the
  caller's `initialCtx` reference can observe those mutations.
  Conversely, the `result.ctx` returned to the caller is the
  same reference the run ended with — mutating it after the run
  may also affect any object the caller still holds. Callers
  who need isolation should clone explicitly before calling or
  after the result returns. The library does not write any
  fields into the ctx — caller-supplied values are passed through
  unchanged.
- `opts.logger` is a function `(entry: TraceEntry) => void`.
  Default: the built-in console logger (§6.6). Called once per
  step **after** the step finishes, with the same `TraceEntry`
  that is appended to the trace.
- `opts.tracer` is an optional function
  `(event: TracerEvent) => void` for **live observation** of the
  run. Unlike the logger, the tracer receives **structured
  events** at multiple points in the run: when steps start and
  end, when sub-activities are entered and left, when parallel
  branches start and end, and when the run itself starts, ends,
  or errors. See §6.8 for the event taxonomy. Default: no tracer
  (no events emitted). Callers who want a live UI of the run
  pass a tracer; the library does not buffer or batch — each
  event is delivered synchronously the moment it occurs.
- `opts.maxSteps` is the run-global step limit. Default `1000`.
- `opts.signal` is an optional `AbortSignal` for **cooperative
  cancellation**. Steps see it via `runInfo.signal`. The library
  performs no action on it itself. See §6.7.
- `opts.killSignal` is an optional `AbortSignal` for **the kill
  switch**. The runner checks it before each node; if aborted,
  the run rejects with `RailRuntimeError(KILLED)`. Not exposed to
  steps directly. See §6.7.

From these options, `run` constructs a **run-state** structured
in two layers:

```js
runState = {
  // Per-fork slots: scalar values, copied on fork.
  // Each fork (sub-activity or parallel branch) owns its own.
  depth:        number,    // sub-activity nesting; 0 at top level
  currentInput: string,    // input port for the next Step-Node invoke

  // Shared sub-object: held by reference; the same object across
  // every fork in the run. Mutations are visible to all forks.
  shared: {
    stepCounter:    number,         // mutable; ++ on each step
    maxSteps:       number,
    killSignal:     AbortSignal | undefined,
    combinedSignal: AbortSignal | undefined,
    logger:         Function,
    tracer:         Function,        // no-op if opts.tracer absent
    flowName:       string,
  }
}
```

**Forking the run-state.** When the runner enters a sub-activity
or a parallel branch, it produces a **fork** of the current
run-state via shallow spread:

```js
const fork = { ...runState };
// fork.depth, fork.currentInput → copied scalars
// fork.shared                    → same reference as runState.shared
```

The caller then overrides per-fork slots as needed (typically
`fork.depth = runState.depth + 1` for sub-activities). Because
JavaScript spreads primitive values by copy and object values
by reference, this single line achieves the right semantics:
per-fork slots become independent, the shared sub-object stays
shared.

**Why two layers.** Per-fork slots describe "where in the
run this frame is" — they must be private to the frame so that
concurrent parallel branches do not overwrite each other's
position. Shared slots describe "what run this is" — they must
be visible to all frames so that, for example, the step counter
is run-global (essential for `maxSteps` to act as a run budget,
not a per-branch budget). Without the layered design, two
parallel Activity-branches sharing a single run-state would
trample each other's `depth` and `currentInput`, producing
wrong values in trace entries and tracer events.

The run-state travels with the run; sub-activities and parallel
branches each receive a fork, while the shared sub-object is
common to all (§8.3, §3.7).

When the runner enters a sub-activity, it forks the run-state
with `depth + 1`, runs the inner loop with the fork, and discards
the fork on return. The outer's run-state is therefore
unmodified — there is no decrement-on-return, and no special
handling for throw paths (the fork simply goes out of scope).
Each `TraceEntry` records the per-fork depth that was active
when the step executed (§6.2).

The run-state is internal: it is not visible to step
implementations. When a step is invoked, the runner constructs a
**run-info** object —
`{ signal: shared.combinedSignal, input: currentInput }` — and
passes it to the step as the second argument (§4). The run-info
is the step-visible projection of the run-state.

### 6.2 Step execution loop

Starting from the activity's entry, the runner walks the graph:

1. Resolve current target. At the entry, follow the (unique) wire
   from the entry to its target. Record the wire's target input
   port: when the target is a node, `runState.currentInput` is
   set to that port name (or to the node's first declared input if
   the wire targets the node directly without specifying a port).
2. If the target is an exit, terminate the loop. The exit name is
   the terminus.
3. **Check the kill switch.** If `runState.shared.killSignal` is
   set and aborted, abort with `RailRuntimeError(KILLED)`.
4. **Check the step counter.** If executing one more node would
   exceed `runState.shared.maxSteps`, abort with
   `RailRuntimeError(STEP_LIMIT_EXCEEDED)`.
5. Execute the node:
   - Capture `t0 = now()`.
   - Emit a `step-start` tracer event with `step`, `depth`
     (= `runState.depth`), `input` (= `runState.currentInput`),
     and `kind` (= `node.railKind`).
   - Call `node.invoke(name, ctx, runState)`, where `name` is the
     node's local name (assigned at `addNode` time). The call
     returns `{ output, ctx? }` (§2 invoke contract) or throws.
     Each kind implements `invoke` differently:
     - A **Step-Node** constructs `runInfo = { signal:
       runState.shared.combinedSignal, input:
       runState.currentInput }`, calls the user function as
       `fn(ctx, runInfo)`, and translates the `StepReturn` (§4)
       into the contract's `{ output, ctx? }` shape.
     - An **Activity** forks the run-state with `depth + 1`,
       emits an `activity-enter` event (carrying the inner
       depth), runs its inner step-execution loop with the
       fork. On normal termination (an exit reached), it emits
       `activity-leave` (carrying the *outer* depth, since the
       fork has been discarded by then) and returns
       `{ output: <exitName>, ctx: <innerCtx> }`. If the inner
       loop propagates a `RailRuntimeError` or
       `RailCompileError`, the activity instead emits
       `activity-throw` (with the propagating error and outer
       depth) and re-throws. The outer's `runState.depth` is
       unchanged in either case.
     - A **Parallel-Node** forks the run-state once per branch
       (each branch gets an independent fork with its own
       per-fork slots, all sharing the same `runState.shared`),
       emits a `branch-start` event before each branch's
       invocation, runs all branches via `Promise.allSettled`.
       For each settled branch, it emits either `branch-end`
       (on success, with the branch's terminal output) or
       `branch-throw` (if the branch propagated an error, with
       the propagating `RailRuntimeError`/`RailCompileError`).
       After all branches settle, it returns
       `{ output: 'done', ctx: <parallel-results-ctx> }` if all
       succeeded, or re-throws the first error in branch
       declaration order otherwise. Parallel-Nodes do not
       increment depth themselves; if a branch is an Activity,
       its inner forks will carry `depth + 1`.
   - Validate the returned `output`: it must be in the node's
     `outputs`. Otherwise raise
     `RailRuntimeError(UNKNOWN_OUTPUT_AT_RUNTIME)` (§5).
   - If the returned object has a `ctx` field, replace the
     running ctx with it; otherwise leave the running ctx
     unchanged.
   - Compute `duration = now() - t0`.
   - Emit a `step-end` tracer event with `step`, `depth`,
     `output`, `duration`, and `kind`.
   - Append a `TraceEntry` to the trace with the current
     `runState.depth`, then call the logger.
   - Resolve the wire from the chosen output and continue at
     step 1 (which will update `runState.currentInput` from the
     next wire's target port).

If `invoke` throws (or its returned Promise rejects), the runner
emits a `step-throw` tracer event (with the original error and
duration), classifies the thrown value (§6.4), and either
re-raises a `RailRuntimeError`/`RailCompileError` as-is or wraps
any other exception into `RailRuntimeError(UNHANDLED_THROW)`. The
trace entry for the throwing step is appended with `threw: true`
and `output: null` before propagation.

The flow itself emits `run-start` once before any step
executes (with `ts: 0`, `depth: 0`, the initial ctx, and the
top-level name), and either `run-end` (with `terminus` and final
ctx) on successful termination, or `run-error` (with the
propagating `RailRuntimeError`) when a graph error occurs.

The compound entry the outer runner appends after a sub-activity
returns carries the *outer's* depth (the depth at which the
sub-activity was invoked), not the inner's. Inner steps logged
during the sub-activity's execution carry the incremented depth.

### 6.3 Output and ctx resolution per node kind

The invoke contract (§2) requires every node kind to return
`{ output, ctx? }` on success. How that shape is produced
differs per kind:

#### Step-Node

The user-provided step function returns a `StepReturn` (§4).
Step-Node invoke translates it into the contract shape:

- String return `'foo'`: invoke result is `{ output: 'foo' }`.
  The runner preserves the running ctx.
- Object return `{ output, ctx? }`: forwarded as-is. If `ctx` is
  present, the runner replaces the running ctx; if absent, the
  runner leaves it unchanged.

#### Activity

Activity invoke runs the inner step-execution loop until an exit
endpoint is reached. The exit's name becomes the `output` of the
returned `{ output, ctx }`; the inner final ctx becomes the
returned `ctx`. The outer runner then replaces the running ctx
with the inner ctx, exactly like for any other node returning
`{ output, ctx }`.

#### Parallel-Node

Parallel-Node invoke runs all branches via `Promise.allSettled`,
collects each branch's terminal `{ output, ctx }`, and returns
`{ output: 'done', ctx: <parallel-results-ctx> }`. The
parallel-results ctx is a typed ctx (§3.12) carrying the
branches' individual results. The outer runner replaces the
running ctx with this typed ctx.

Across all kinds, the runner enforces the same rules: the
returned `output` must be in the node's declared `outputs`
(otherwise `RailRuntimeError(UNKNOWN_OUTPUT_AT_RUNTIME)`); a
returned `ctx` field replaces the running ctx; absence preserves.

### 6.4 Behaviour when a step throws

When a step throws (or the returned Promise rejects), the runner
classifies the thrown value:

1. **`RailRuntimeError` or `RailCompileError`:** re-thrown
   unchanged. It propagates out of `flow.run(...)` directly.
2. **Anything else:** wrapped into
   `RailRuntimeError(UNHANDLED_THROW)` with the original error as
   `cause`. The run is aborted; the wrapped error propagates out
   of `flow.run(...)`.

The library has no `throws`-mapping mechanism: every thrown
exception is a graph error. Steps that need to convert exceptions
into named outputs do so themselves with `try`/`catch` (§4.1).

A `TraceEntry` is appended for the throwing step with
`threw: true`, `output: null`, and the original error attached.
This is the last entry in the trace before propagation.

### 6.5 Termination

The run terminates when:

- An exit endpoint is reached. The terminus is the exit's name and
  the caller receives a `RunResult`.
- A `RailRuntimeError` is raised. It propagates out of
  `flow.run(...)` without a `RunResult`.

A step counter exceeding `maxSteps` is the safeguard; it raises
`RailRuntimeError(STEP_LIMIT_EXCEEDED)`.

`maxSteps` is **run-global**: every step executed during the run
counts against the same counter, regardless of where it runs —
top-level, inside a sub-activity, or inside a parallel branch.
Because JavaScript is single-threaded and the counter is
incremented synchronously per step, there is no race; whichever
step crosses the limit first throws, and any other branches stop
at their next step (which would also cross the limit). Programs
that legitimately need many steps across parallel branches
should set `maxSteps` accordingly.

### 6.6 Logger

The default logger writes one line per step to `console.log`,
prefixed with the flow's top-level name. Step names are indented
by two spaces per level of `entry.depth`:

```
[rail:sendMessage] OK   validate         (0.07ms) -> ok
[rail:sendMessage] OK   encrypt          (3.21ms) -> ok
[rail:sendMessage] OK     inner.encrypt  (2.15ms) -> ok
[rail:sendMessage] OK     inner.send     (8.41ms) -> ok
[rail:sendMessage] OK   inner            (10.62ms) -> success
[rail:sendMessage] XX   parse            (0.42ms) -> (lib error: UNKNOWN_OUTPUT_AT_RUNTIME)
```

The first three columns (flow prefix, tag, step name) form a
visual block; the indentation reflects sub-activity nesting. The
compound entry for a sub-activity (`inner` in the example) sits
at the outer's depth, while its inner steps are one level
deeper.

Tags are determined purely from the trace entry:

- **`OK`** — the step produced a normal output (`threw === false`).
- **`XX`** — the step threw an exception (`threw === true`),
  triggering `RailRuntimeError(UNHANDLED_THROW)`, or returned an
  unknown output triggering `RailRuntimeError(UNKNOWN_OUTPUT_AT_RUNTIME)`,
  or any other `RailRuntimeError` originating at this step. The
  logger is invoked once for the failing step before the error
  propagates out of `flow.run(...)`.

The `depth` is also available as a numeric field on the
`TraceEntry`; custom loggers can format it however they want
(numeric, indentation, or ignore it).

A custom logger may be passed via `opts.logger`. If the logger
throws, the runner raises `RailRuntimeError(LOGGER_FAILED)` with
the original error as `cause`. Logger failures are graph errors
(§5).

For live observation during the run (rather than post-hoc step
summaries), use `opts.tracer` instead of (or in addition to)
`opts.logger`. See §6.8.

### 6.7 Cancellation: `signal` and `killSignal`

The library supports two distinct cancellation mechanisms.

#### Cooperative cancellation (`opts.signal`)

The caller passes an `AbortSignal` as `opts.signal`. The runner
exposes it to step implementations as `runInfo.signal` (the
second parameter to step functions, §4). The library performs no
action on this signal itself; steps decide how to react.

Typical patterns:

- A step passes the signal to abortable I/O:

  ```js
  async function send(ctx, runInfo) {
    const res = await fetch(url, { signal: runInfo.signal });
    // ...
  }
  ```

  When the caller aborts, the I/O rejects. The step catches and
  returns a named output (e.g. `'cancelled'`).

- A step polls between sub-operations:

  ```js
  async function process(ctx, runInfo) {
    for (const item of items) {
      if (runInfo.signal?.aborted) return 'cancelled';
      await processItem(item);
    }
    return 'ok';
  }
  ```

The library models cancellation as a normal flow: a `'cancelled'`
output, possibly followed by a cleanup step, ending at a
`cancelled` exit. The run terminates with
`RunResult { terminus: 'cancelled' }`.

#### Kill switch (`opts.killSignal`)

The caller passes an `AbortSignal` as `opts.killSignal`. This is
the emergency exit: a way to stop the run when cooperative
cancellation is not possible.

The runner observes `killSignal` directly. Before starting each
node execution (§6.2 step 3), it checks whether
`killSignal.aborted` is true; if so, no further node is started
and the run rejects with `RailRuntimeError(KILLED)`. The trace
up to the kill point is attached to the error.

Steps **do not** see `killSignal` directly. It is not part of
`runInfo`. The library makes no attempt to interrupt a step
that is already running. The only guarantee is: **once
`killSignal` has aborted, no further node will be started.**

#### Linking `signal` and `killSignal`

When `killSignal` is set, the runner constructs `runInfo.signal`
by combining `opts.signal` and `opts.killSignal`: it aborts as
soon as either of them aborts. A kill-switch abort therefore
propagates into in-flight cooperative I/O automatically.

The combination is for *step-visible* purposes only. The runner
observes the raw `killSignal` for its own kill check.

| Caller passes               | `runInfo.signal` is                                  | Runner kill-checks |
|-----------------------------|------------------------------------------------------|--------------------|
| neither                     | `undefined`                                          | no                 |
| `signal` only               | `opts.signal`                                        | no                 |
| `killSignal` only           | a derived signal that aborts when `killSignal` does  | yes                |
| both                        | a derived signal that aborts when either does        | yes                |

#### Sub-activities

When the runner enters a sub-activity node, it calls
`inner.invoke(name, ctx, runState)` (§8.3) — passing through the
same run-state. The inner run shares the same `killSignal` and
the same combined signal; steps in the sub-activity see it as
their own `runInfo.signal`.

#### `parallel` branches

In a Parallel-Node, all branches share the same run-state and
therefore the same `killSignal` and the same combined signal
exposed via each step's `runInfo.signal`. If the kill switch
fires, all running branches receive the abort signal and the
outer run rejects with `KILLED`.

If a branch raises a `RailRuntimeError` or `RailCompileError`,
the parallel node activates an internal abort (linked into the
combined signal of all sibling branches), waits for
`Promise.allSettled`, then propagates the error.

### 6.8 Tracer events

The optional `opts.tracer` callback receives **structured events**
during the run, enabling live observation (e.g. for a web UI that
visualises the workflow in real time). The tracer is independent
of the logger: the logger receives finished step entries
(post-hoc, summary), the tracer receives lifecycle events
(real-time, fine-grained).

If `opts.tracer` is not provided, no events are emitted (zero
overhead).

#### Event shape

Every event has at least:

- `type: string` — discriminates the event kind (see below).
- `ts: number` — millisecond timestamp (`performance.now()`-based)
  when the event was emitted, relative to run-start. The event of
  type `'run-start'` always has `ts: 0`.
- `depth: number` — the run-state depth at the time of emission.

Per-type fields are listed below.

#### Event taxonomy

```js
TracerEvent =
  | { type: 'run-start',
      ts: 0,
      depth: 0,
      name: string,                   // flow's top-level name
      ctx: Object }                   // initial ctx (by reference)

  | { type: 'run-end',
      ts: number,
      depth: 0,
      terminus: string,               // top-level output reached
      ctx: Object }                   // final ctx

  | { type: 'run-error',
      ts: number,
      depth: 0,
      error: RailRuntimeError }       // the propagating error

  | { type: 'step-start',
      ts: number,
      depth: number,
      step: string,                   // node's local name (or dotted path)
      input: string,                  // the activated input port
      kind: 'step' | 'activity' | 'parallel' }

  | { type: 'step-end',
      ts: number,
      depth: number,
      step: string,
      output: string,                 // the produced output port
      duration: number,               // milliseconds
      kind: 'step' | 'activity' | 'parallel' }

  | { type: 'step-throw',
      ts: number,
      depth: number,
      step: string,
      error: Error,                   // the thrown value
      duration: number,
      kind: 'step' | 'activity' | 'parallel' }

  | { type: 'activity-enter',
      ts: number,
      depth: number,                  // inner depth (= outer depth + 1)
      name: string }                  // sub-activity local name

  | { type: 'activity-leave',
      ts: number,
      depth: number,                  // outer depth (the fork is gone)
      name: string,
      output: string }                // exit name reached

  | { type: 'activity-throw',
      ts: number,
      depth: number,                  // outer depth (the fork is gone)
      name: string,
      error: Error,                   // the propagating RailRuntimeError or RailCompileError
      duration: number }              // ms from activity-enter

  | { type: 'branch-start',
      ts: number,
      depth: number,                  // outer depth (parallel-node's depth)
      branch: string }                // branch key in the parallel map

  | { type: 'branch-end',
      ts: number,
      depth: number,                  // outer depth
      branch: string,
      output: string }                // branch's terminal output

  | { type: 'branch-throw',
      ts: number,
      depth: number,                  // outer depth
      branch: string,
      error: Error,                   // the propagating RailRuntimeError or RailCompileError
      duration: number }              // ms from branch-start
```

Each lifecycle (step / activity / branch / run) has three
events: a start, a success-end, and a failure-end. The pairs
`step-end` / `step-throw`, `activity-leave` / `activity-throw`,
`branch-end` / `branch-throw`, and `run-end` / `run-error` are
mutually exclusive — exactly one of each pair is emitted per
lifecycle.

The `activity-leave` and `activity-throw` events are emitted
**after** the inner fork goes out of scope, so their `depth` is
the outer's depth — the state the runner has just returned to.
(The corresponding `activity-enter` event carries the inner
depth.) Symmetrically, `branch-start`, `branch-end`, and
`branch-throw` carry the outer (parallel-node's) depth; if a
branch is itself an Activity, the inner Activity's own
`activity-enter` will follow with the incremented depth.

The `error` field on `step-throw` depends on the node's
`railKind`:

- For **Step-Nodes** (`kind: 'step'`), it is the value the user
  function actually threw — pre-wrapping. This is the underlying
  cause closest to the source.
- For **Activities and Parallel-Nodes used as nodes** (`kind:
  'activity'` or `'parallel'`), the inner step-execution loop has
  already wrapped any user-thrown value into a
  `RailRuntimeError`/`RailCompileError` before it propagates out
  of that node's `invoke`. The `error` here is therefore that
  already-wrapped error — relative to the originally-throwing
  inner step, it is "post-wrapping". The original underlying
  thrown value is available via `error.cause` if the wrap
  occurred at this level.

The `error` field on `activity-throw` and `branch-throw` is the
`RailRuntimeError`/`RailCompileError` actually **propagating
out** of that scope. By construction this matches the `error` of
the corresponding outer `step-throw` for the same node (which
the runner emits immediately after).

For tracers, the practical rule of thumb: `step-throw` on a
Step-Node shows the user's underlying problem;
`step-throw`/`activity-throw`/`branch-throw` on or around a
composite node shows what the calling scope sees.

#### Event ordering

For a typical run with sub-activities and parallel branches, the
event sequence is:

```
run-start
  step-start    (top-level step or activity)
    activity-enter   (if the node is an activity)
      step-start  ...
      step-end    ...
    activity-leave
  step-end
  step-start    (parallel node)
    branch-start  (each branch, interleaved)
      step-start  ...
      step-end    ...
    branch-end
    branch-start  ...
    branch-end    ...
  step-end       (parallel)
run-end
```

The error-path equivalents replace the success-end events with
their throw counterparts:

```
run-start
  step-start    (top-level activity)
    activity-enter
      step-start  ...
      step-throw    (an inner step threw — error: the original thrown value)
    activity-throw  (the activity propagates — error: the wrapping RailRuntimeError)
  step-throw      (the runner emits step-throw on the activity-as-node)
run-error         (the run aborts — error: the propagating RailRuntimeError)
```

For a Parallel-Node where one branch fails: branches start
concurrently, their inner step events interleave by `await`
order, and `Promise.allSettled` waits for **every** branch to
settle before the Parallel-Node propagates. So both branches
emit their respective end events (success or failure) in
non-deterministic order, and only after all have settled does
the runner emit the outer `step-throw` and `run-error`. A
representative interleaving:

```
  step-start    (parallel node)
    branch-start  branchA
    branch-start  branchB         (started together; subsequent ordering depends on await scheduling)
      step-start  branchA.fetchKeys
      step-start  branchB.loadProfile
      step-end    branchB.loadProfile
      step-start  branchB.validateProfile
      step-throw  branchB.validateProfile   (an inner step threw)
      step-end    branchA.fetchKeys
      step-start  branchA.deriveSession
      step-end    branchA.deriveSession
    branch-end    branchA  (success — A finished its work despite B failing)
    branch-throw  branchB  (error: the propagating RailRuntimeError)
  step-throw      (parallel node — error: same RailRuntimeError as branchB's)
run-error
```

Two things to note. First, the relative order of events from
different branches is not guaranteed; only the order *within*
one branch is sequential. Second, even when a branch fails,
`allSettled` lets sibling branches run to their natural
completion (or to their own failure), so each branch reliably
emits exactly one of `branch-end` / `branch-throw`. The outer
`step-throw` and `run-error` are emitted only after all
branches have settled. Sibling branches that have not yet
finished cooperative work when one fails will see the combined
abort signal flip (§3.7's internal abort linkage) and may end
via `step-throw` (`AbortError` in their own steps) shortly
after.

Each lifecycle scope (step, activity, branch, run) emits exactly
one start event and exactly one end event (success or failure).
A tracer-driven UI can therefore reliably reset highlights and
animations on the matching end event without inferring closure
from the absence of one.

#### Concurrent branches and per-fork state

When multiple Activity branches inside a Parallel-Node interleave
via `await`, their per-fork run-state slots (`depth`,
`currentInput`) are independent because each branch was given
its own fork (§6.1, §3.7). This means events emitted from
different branches carry the correct `depth` values, even when
the branches' `await`s interleave: the branch-A's depth changes
do not bleed into branch-B's events, and vice versa. The
`shared` sub-object — counter, signals, logger, tracer, flow
name — remains common, so the step counter increments globally
across branches and the tracer receives events from all of them
in the order they are emitted.

#### Tracer contract

- The tracer is called **synchronously**. The library does not
  `await` its return value; if it returns a Promise, the Promise
  is ignored. Tracers that need to deliver events asynchronously
  (e.g. via WebSocket) must buffer internally.
- The tracer must not throw. If it does, the run aborts with
  `RailRuntimeError(TRACER_FAILED)` carrying the original error
  as `cause`.
- The tracer must not mutate the event objects. Library code
  may reuse event payloads across delivery in future versions;
  treat them as read-only.
- The tracer **may** start new flow runs during event handling,
  via `flow.run(...)` on the same or a different flow. Each
  new run allocates its own run-state in its own closure (flow
  objects are stateless, §3.6) and proceeds independently. Events
  from the new run go to whatever tracer is configured in its
  own `opts`, not back to the outer tracer; the two runs are
  fully separate. Compiling already-compiled nodes during event
  handling is also safe (compile is idempotent).

The tracer is intended for **observation**, not control of the
emitting run. It cannot influence its own run's outcome — to
abort a run from outside, use `opts.killSignal`.

#### catching wrappers and tracer visibility

A `catching(...)` wrapper (§3.13) is, from the runtime's
perspective, a single Step-Node. The tracer therefore observes
**only** the wrapper's `step-start`/`step-end` (or `step-throw`)
events; the inner step's exception that the wrapper translates
into an output is not visible as a separate event. This is
consistent with the design intent that a `catching`-wrapped
node looks like one node in the topology — but it means a UI
that hopes to show the original error name (e.g. `NetworkError`
that was mapped to `'net5xx'`) cannot get it from the tracer.
Steps that need to expose the underlying exception to observers
should use `try`/`catch` with `exceptionCtx(...)` (§3.12)
instead of `catching(...)`, since the resulting exception ctx
flows through the run as a regular ctx and can be examined by
downstream nodes (and indirectly observed via the tracer's
ctx-bearing events at `step-end`).

#### Relationship to logger

A tracer subsumes what a logger does, plus more. Most users
choose **one or the other**:

- **Logger only:** for diagnostic console output during
  development. Simpler shape (one entry per finished step).
- **Tracer only:** for live UIs, integration with external
  observability tools, or recording detailed run histories.
- **Both:** valid but typically redundant; the events delivered
  by the tracer cover everything the logger sees plus the
  start/enter/leave/error transitions.

When both are present, the tracer is invoked first for
`step-end` / `step-throw`, then the logger is invoked with the
appended `TraceEntry`.

---

## 7. Compile-time validation

`Activity.compile()` runs in **three phases**. Errors are
collected within a phase and reported together; if any phase
produces errors, the next phase is **not** executed.

```js
class RailCompileError extends Error {
  name = 'RailCompileError';
  phase: 'declaration' | 'completeness' | 'topology';
  errors: CompileIssue[];
  // Note: no `activity` field — activities are anonymous. Outer code
  // wraps inner compile errors with a path hint identifying the
  // failing sub-node by its name in the parent.
}

CompileIssue = {
  code: string,
  // additional fields per code (see below)
  suggestion?: string,
}
```

`compile()` is **idempotent**: if the activity is already in the
compiled state (`compiled() === true`), it returns immediately
without redoing work. Otherwise it proceeds through the three
phases.

Note that wire-direction checks, ambiguous-input checks, and
cross-builder handle checks happen **at the wire-call site** as
synchronous `RailBuildError` (§3.3, §5.4) — not as compile
phases. By the time `compile()` is invoked, all wires are
guaranteed to be structurally valid (correct direction, unambiguous
inputs, same builder); compile concerns itself with completeness
and topology only.

Before the three phases, `compile()` recursively compiles every
sub-node by invoking `node.compile()` on each. Each sub-node's
`compile()` is itself idempotent, so this is safe to call
regardless of whether the sub-node is already compiled. For
Step-Nodes, sub-compile validates the node's own configuration.
For Activity sub-nodes, sub-compile recursively compiles the
inner activity. For Parallel-Nodes, sub-compile compiles each
branch.

If a sub-node's compile raises a `RailCompileError`, the outer
compile nests it as a sub-error with a path hint identifying the
nesting node, and proceeds to its own phase A.

This recursive-compile-via-`compile()` mechanism gives implicit,
identity-based memoisation: any node instance is compiled at most
once across all its uses, because compilation is idempotent.
Passing the same node instance to multiple `addNode` calls — or
using the same Activity in multiple outer activities — results in
compilation happening exactly once.

### Phase A — declaration

| Code                            | Meaning                                                         | Fields              |
|---------------------------------|-----------------------------------------------------------------|---------------------|
| `NO_ENTRY`                      | No `a.entry(...)` declared.                                     | —                   |
| `MULTIPLE_ENTRIES`              | `a.entry(...)` called more than once.                           | `names: string[]`   |
| `NO_EXITS`                      | No exits declared.                                              | —                   |
| `DUPLICATE_NODE`                | Two `a.addNode(...)` with the same name.                        | `name`              |
| `DUPLICATE_EXIT`                | Two `a.exit(...)` with the same name.                           | `name`              |
| `EMPTY_OUTPUTS`                 | A node was declared with empty `outputs`.                       | `node`              |
| `DUPLICATE_OUTPUT`              | Same output name listed twice on a node.                        | `node`, `output`    |
| `EMPTY_INPUTS`                  | A node was declared with empty `inputs`.                        | `node`              |
| `DUPLICATE_INPUT`               | Same input name listed twice on a node.                         | `node`, `input`     |
| `NOT_A_NODE`                    | `addNode` was called with a value that is not a Rail-Node.      | `name`              |

Note: There is no `OUTPUTS_NOT_ALLOWED` error any more — `outputs`
is a property of the node itself, set at construction time. The
builder method `addNode(name, node)` accepts only nodes; there is
no parallel options-object parameter that could conflict.

There are also no `throws`-related codes in Phase A: the library
has no `throws`-mapping mechanism (§4.1).

### Phase B — completeness

| Code                       | Meaning                                                  | Fields                |
|----------------------------|----------------------------------------------------------|-----------------------|
| `ENTRY_NOT_WIRED`          | Entry has no outgoing wire.                              | —                     |
| `MULTIPLE_ENTRY_WIRES`     | Entry has more than one outgoing wire.                   | `count`               |
| `UNWIRED_OUTPUT`           | Some node-output has no outgoing wire.                   | `node`, `output`      |
| `MULTIPLE_OUTGOING_WIRES`  | A single node-output has more than one outgoing wire.    | `node`, `output`, `count` |
| `EXIT_NOT_WIRED`           | An exit has no incoming wire.                            | `exit`                |

Multiple incoming wires to the same node-input are **not** an
error (see §7.5, convergence).

A declared node-input that is **not** wired (no incoming wire)
is also **not** an error. Such an input is dead topology — it
can never be activated at runtime — but the asymmetry to
`UNWIRED_OUTPUT` is intentional: an unwired output breaks the
run when reached at runtime (no path forward); an unwired input
simply cannot be reached, which is harmless. Programmers
declaring inputs they intend to wire later, or keeping inputs
for documentation purposes, are not penalised.

### Phase C — topology

| Code                       | Meaning                                                  | Fields                          |
|----------------------------|----------------------------------------------------------|---------------------------------|
| `UNREACHABLE_NODE`         | No path from entry to this node.                         | `node`                          |
| `UNREACHABLE_EXIT`         | No path from entry to this exit.                         | `exit`                          |
| `CYCLE`                    | A cycle exists in the wire graph.                        | `path: string[]`                |

Reachability follows the wire graph only. Since the library has
no `throws`-mapping mechanism, there are no implicit edges to
account for.

### 7.5 Convergence

Multiple wires may end at the same node-input. This is
**convergence**: a syntactic shorthand meaning "no matter which
path led here, the flow continues from this node". At runtime,
only one of the converging wires is active per run (because the
upstream node produces only one output). The trace remains
linear.

Convergence is distinct from `parallel(...)`, which is the only
form of parallel execution in the library.

---

## 8. Sub-activities and recursive compile

Any Rail-Node may be added as a sub-node via
`a.addNode(name, node)`. The builder treats Step-Nodes,
Activities, and Parallel-Nodes uniformly: they all expose the
same `compile()`/`compiled()`/`invoke()` interface.

### 8.1 Declaration

```js
const inner = activity((a) => {
  const start   = a.entry('in');
  const success = a.exit('success');
  const failure = a.exit('failure');
  const encrypt = a.addNode('encrypt',
    node(encryptFn, { outputs: ['ok', 'noKeys'] }));
  const send    = a.addNode('send',
    node(sendFn, { outputs: ['ok', 'net5xx'] }));

  a.wire(start,                   encrypt);
  a.wire(encrypt.out('ok'),       send);
  a.wire(encrypt.out('noKeys'),   failure);
  a.wire(send.out('ok'),          success);
  a.wire(send.out('net5xx'),      failure);
});
// inner.outputs === ['success', 'failure']

const outer = activity((a) => {
  const start     = a.entry('in');
  const success   = a.exit('success');
  const failure   = a.exit('failure');
  const preflight = a.addNode('preflight',
    node(preflightFn, { outputs: ['ok', 'skip'] }));
  const wrapped   = a.addNode('inner', inner);

  a.wire(start,                   preflight);
  a.wire(preflight.out('ok'),     wrapped);
  a.wire(preflight.out('skip'),   success);
  a.wire(wrapped.out('success'),  success);
  a.wire(wrapped.out('failure'),  failure);
});
```

### 8.2 Compile and runtime behavior

When `outer.compile()` runs, it invokes `compile()` on every
sub-node, which in turn recursively compiles inner nodes. The
operation terminates because compile is idempotent: any node
already compiled returns immediately.

When the runner reaches a sub-activity node during execution, it
calls `inner.invoke('inner', ctx, runState)` — using the local
name assigned at `addNode` time — and shares the outer run-state.
The step counter, signals, and logger are common to both. A kill
terminates outer and inner together; cooperative cancellation
propagates without re-plumbing.

The sub-activity's `invoke` follows the standard contract (§2):
it returns `{ output, ctx? }` or throws.

- On success, `output` is the inner activity's exit name (since
  exits *are* outputs of the activity, §3.5). The compound output
  used by the outer runner is exactly that `output`; the compound
  ctx becomes the inner ctx (replace, not merge), exactly as if
  the compound node were a regular step that returned
  `{ output, ctx }`.
- On failure, the sub-activity throws a `RailRuntimeError` or
  `RailCompileError`; the error propagates unchanged (§5). A
  `KILLED` raised inside the inner run propagates straight out;
  the outer run does not get a chance to "rescue" it.

There is no third case. The inner runtime either reaches an exit
(success path) or a step throws and the inner runner produces a
`RailRuntimeError(UNHANDLED_THROW)`.

The term "terminus" appears only in the **`RunResult` of the
top-level Flow run** (§3.6), where the final invoke output is
exposed under that name. Inside the runner — including for
sub-activities — every `invoke` produces an `output`.

### 8.3 Identity-based memoisation

Because compile is idempotent and recursive, **the same node
instance is compiled exactly once**, no matter how many places
reference it. The memoisation is implicit and automatic; there is
no cache, no flag-tracking gymnastics, no separate
"compiled-version" object — just the node's own `compiled()`
flag.

Example:

```js
// 1) Define an inner activity. Not compiled yet.
const inner = activity((a) => {
  const s  = a.entry('in');
  const ok = a.exit('ok');
  const n  = a.addNode('do', node(() => 'ok', { outputs: ['ok'] }));
  a.wire(s, n);
  a.wire(n.out('ok'), ok);
});
// inner.compiled() === false

// 2) Use inner in two places of one outer activity. Same instance.
const outer1 = activity((a) => {
  const s  = a.entry('in');
  const ok = a.exit('ok');
  const first  = a.addNode('first',  inner);
  const second = a.addNode('second', inner);   // same instance
  a.wire(s, first);
  a.wire(first.out('ok'),  second);
  a.wire(second.out('ok'), ok);
});
outer1.compile();
// inner was compiled exactly once during outer1.compile().

// 3) Use inner again in a different outer activity.
const outer2 = activity((a) => {
  const s  = a.entry('in');
  const ok = a.exit('ok');
  const use = a.addNode('use', inner);
  a.wire(s, use);
  a.wire(use.out('ok'), ok);
});
outer2.compile();
// inner.compile() is called again here, but is a no-op
// (inner.compiled() is already true).
```

A user who wants a *separate* compilation (for example, to
isolate runtime state) must build a separate Activity instance.
Two activities defined by separate `activity(...)` calls are
distinct instances even if their builders are identical.

The same applies to step-nodes and parallel-nodes: a single
`node(fn, opts)` value can be added under different names in
different activities, sharing one compilation.

### 8.4 Trace embedding

The sub-activity's trace is embedded into the outer trace, with
each inner `step` field prefixed by the compound node's name and
a dot. The `depth` field reflects the nesting level: inner steps
are one level deeper than the outer's depth, while the compound
entry sits at the outer's depth:

```
preflight        depth=0  (0.40ms)  -> ok
inner.encrypt    depth=1  (2.15ms)  -> ok
inner.send       depth=1  (8.41ms)  -> ok
inner            depth=0  (10.62ms) -> success    [compound]
```

The compound entry's `step` is the compound node's name (without
dot). Its `duration` covers the whole `inner.invoke(...)`. Its
`depth` is the depth at which the outer invoked the
sub-activity — useful when aggregating durations across the
trace, since the compound's duration is the sum of inner work
plus inter-step overhead, and one can identify what is "outer
work" vs "inner work" by depth alone.

For doubly-nested sub-activities, depth grows accordingly: a
step three levels deep has `depth: 3`. Parallel-Nodes do not
contribute to depth themselves; if a parallel branch is an
Activity, that Activity's invocation increments depth as any
sub-activity would.

#### Naming inside parallel branches

When a Parallel-Node `parallel({ branchA: ..., branchB: ... })`
runs an Activity branch, the inner steps' names follow the same
dot-prefix convention as for Sub-Activities, with the
Parallel-Node's name and the branch key both contributing:

```
fan.branchA.validate    depth=1  (...)  -> ok
fan.branchA.encrypt     depth=1  (...)  -> ok
fan.branchA             depth=0  (...)  -> success   [branch's compound entry]
fan.branchB.lookup      depth=1  (...)  -> ok
fan.branchB             depth=0  (...)  -> success   [branch's compound entry]
fan                     depth=0  (...)  -> done      [parallel-node entry]
```

The naming is fully qualified: `<parallel-name>.<branch-key>` for
the branch's compound, then `<parallel-name>.<branch-key>.<inner>`
for steps inside an Activity branch. This guarantees uniqueness
even when the same branch keys appear in multiple Parallel-Nodes
within one outer Activity (e.g. `fan1.profile.validate` vs
`fan2.profile.validate` — distinguishable). Step-Node branches
contribute a single entry of the form `<parallel-name>.<branch-key>`
with no further dots.

### 8.5 Mermaid

Sub-activity nodes render as subroutine-shaped nodes
(`name[[label]]`) with class `subActivity`. Not expanded inline
(§13).

### 8.6 Recursion guard

Activities are sealed after the builder closure returns;
references in the parent activity capture the inner activity at
`addNode` time. There is no runtime recursion possibility within
a graph.

---

## 9. Examples

### 9.1 Minimal happy-path activity

```js
import { activity, node, flow } from './rail.js';

const greet = activity((a) => {
  const start   = a.entry('in');
  const success = a.exit('success');
  const hello   = a.addNode('hello',
    node(async (ctx) => ({
      output: 'success',
      ctx: { ...ctx, greeting: `Hello, ${ctx.name}!` },
    }), { outputs: ['success'] }));

  a.wire(start,                hello);
  a.wire(hello.out('success'), success);
});

greet.compile();
const r = await flow('greet', greet).run({ name: 'Markus' });
// r.terminus === 'success'
// r.ctx.greeting === 'Hello, Markus!'
```

### 9.2 Branching with named outputs and `catching`

```js
import { activity, node, catching, flow } from './rail.js';

const sendMessage = activity((a) => {
  const start   = a.entry('in');
  const { success, failure } = a.standardExits();

  const validate = a.addNode('validate',
    node(validateFn, { outputs: ['ok', 'invalid'] }));
  const encrypt  = a.addNode('encrypt',
    node(encryptFn, { outputs: ['ok', 'noKeys'] }));
  const send     = a.addNode('send', catching(
    node(sendFn, { outputs: ['ok'] }),
    {
      NetworkError: 'net5xx',
      AbortError:   'cancelled',
    }
  ));
  // send's effective outputs: ['ok', 'net5xx', 'cancelled']

  a.wire(start,                   validate);
  a.wire(validate.out('ok'),      encrypt);
  a.wire(validate.out('invalid'), failure);
  a.wire(encrypt.out('ok'),       send);
  a.wire(encrypt.out('noKeys'),   failure);
  a.wire(send.out('ok'),          success);
  a.wire(send.out('net5xx'),      failure);
  a.wire(send.out('cancelled'),   failure);
});

sendMessage.compile();
const sendMessageFlow = flow('sendMessage', sendMessage);

async function validateFn(ctx) {
  if (!ctx.roomId) return 'invalid';
  return { output: 'ok', ctx: { ...ctx, validated: true } };
}

// sendFn just throws on network errors — `catching` translates.
async function sendFn(ctx, runInfo) {
  await fetch(ctx.url, { body: ctx.body, signal: runInfo.signal });
  return 'ok';
}
```

The `catching(...)` wrapper turns thrown `NetworkError`/`AbortError`
exceptions into named outputs declaratively. `sendFn` itself stays
small and doesn't need a hand-written `try`/`catch`. In Mermaid,
the `send` node appears as a single rectangle with three outgoing
edges (`ok`, `net5xx`, `cancelled`) — the wrapper is invisible
from the graph's perspective.

### 9.3 Sub-activity composition

```js
const inner = activity((a) => {
  const start = a.entry('in');
  const { success, failure } = a.standardExits();
  const encrypt = a.addNode('encrypt',
    node(encryptFn, { outputs: ['ok', 'noKeys'] }));
  const send    = a.addNode('send',
    node(sendFn, { outputs: ['ok', 'net5xx'] }));

  a.wire(start,                 encrypt);
  a.wire(encrypt.out('ok'),     send);
  a.wire(encrypt.out('noKeys'), failure);
  a.wire(send.out('ok'),        success);
  a.wire(send.out('net5xx'),    failure);
});

const outer = activity((a) => {
  const start = a.entry('in');
  const { success, failure } = a.standardExits();
  const preflight = a.addNode('preflight',
    node(preflightFn, { outputs: ['ok', 'skip'] }));
  const wrapped   = a.addNode('inner', inner);

  a.wire(start,                  preflight);
  a.wire(preflight.out('ok'),    wrapped);
  a.wire(preflight.out('skip'),  success);
  a.wire(wrapped.out('success'), success);
  a.wire(wrapped.out('failure'), failure);
});

outer.compile();   // recursively compiles `inner` if not already compiled
const outerFlow = flow('outer', outer);
```

### 9.4 Compile error example

```js
const broken = activity((a) => {
  const start = a.entry('in');
  const { success, failure } = a.standardExits();
  const stepA = a.addNode('a', node(() => 'ok', { outputs: ['ok', 'bad'] }));
  a.wire(start,             stepA);
  a.wire(stepA.out('ok'),   success);
  // 'bad' output is unwired
  // 'failure' exit has no incoming wire
});

try {
  broken.compile();
} catch (e) {
  // e instanceof RailCompileError
  // e.phase === 'completeness'
  // e.errors === [
  //   { code: 'UNWIRED_OUTPUT', node: 'a', output: 'bad' },
  //   { code: 'EXIT_NOT_WIRED', exit: 'failure' },
  // ]
}
```

### 9.5 Parallel execution with evaluation node

```js
import { activity, node, parallel, flow, isParallelCtx } from './rail.js';

const loadProfileAndKeys = activity((a) => {
  const start  = a.entry('in');
  const ok     = a.exit('ok');
  const failed = a.exit('failed');

  const fan = a.addNode('parallel',
    parallel({
      profile: profileActivity,
      keys:    keysActivity,
    }));

  const evaluate = a.addNode('evaluate',
    node(evaluateFn, { outputs: ['ok', 'failed'] }));

  a.wire(start,                  fan);
  a.wire(fan.out('done'),        evaluate);
  a.wire(evaluate.out('ok'),     ok);
  a.wire(evaluate.out('failed'), failed);
});

loadProfileAndKeys.compile();
// recursively compiles the Parallel-Node, which recursively
// compiles profileActivity and keysActivity.

async function evaluateFn(ctx) {
  // ctx has __type: 'parallel-results' here (isParallelCtx(ctx) === true)
  const { inputCtx, results } = ctx;
  if (results.profile.terminus !== 'success' ||
      results.keys.terminus    !== 'success') {
    return {
      output: 'failed',
      ctx: { ...inputCtx, error: collectErrors(results) },
    };
  }
  return {
    output: 'ok',
    ctx: {
      ...inputCtx,
      profile: results.profile.ctx.profile,
      keys:    results.keys.ctx.keys,
    },
  };
}
```

### 9.6 Catching exceptions with `exceptionCtx` and a downstream evaluator

When a step needs to call code that may throw and the failure
should be handled by the graph, the step catches the exception
itself, wraps it via `exceptionCtx(...)`, and emits it on a
named output. The downstream evaluator detects the typed ctx with
`isExceptionCtx(...)` and decides what to do:

```js
import { activity, node, exceptionCtx, isExceptionCtx } from './rail.js';

const robust = activity((a) => {
  const start = a.entry('in');
  const { success, failure } = a.standardExits();

  const op = a.addNode('op', node(async (ctx) => {
    try {
      const r = await dangerousOp(ctx);
      return { output: 'ok', ctx: { ...ctx, result: r } };
    } catch (e) {
      return { output: 'failed', ctx: exceptionCtx(e, ctx) };
    }
  }, { outputs: ['ok', 'failed'] }));

  const recover = a.addNode('recover', node(async (ctx) => {
    if (!isExceptionCtx(ctx)) {
      return { output: 'fatal', ctx };
    }
    const { inputCtx, error } = ctx;
    if (error.name === 'TimeoutError') {
      return { output: 'ok', ctx: { ...inputCtx, retried: true } };
    }
    return { output: 'fatal', ctx: { ...inputCtx, lastError: error } };
  }, { outputs: ['ok', 'fatal'] }));

  a.wire(start,                op);
  a.wire(op.out('ok'),         success);
  a.wire(op.out('failed'),     recover);
  a.wire(recover.out('ok'),    success);
  a.wire(recover.out('fatal'), failure);
});
```

The wire from `op.out('failed')` to `recover` is a regular
solid edge — there are no hidden throws-paths in the graph.

### 9.7 Top-level Step-Node

A flow can hold any Rail-Node, not just an Activity. A
single-step workflow can be useful for isolated step logic or for
testing:

```js
import { node, flow } from './rail.js';

const greet = node(async (ctx) => ({
  output: 'done',
  ctx: { ...ctx, msg: `Hi ${ctx.name}` },
}), { outputs: ['done'] });

greet.compile();
const r = await flow('greet', greet).run({ name: 'Markus' });
// r.terminus === 'done'
```

### 9.8 Reusing a node under multiple names

A single `node(...)` value can be added in multiple places of one
or more activities. It is compiled exactly once.

```js
const validateNode = node(validateFn, { outputs: ['ok', 'invalid'] });

const flowA = activity((a) => {
  const s = a.entry('in');
  const { success, failure } = a.standardExits();
  const v = a.addNode('validate', validateNode);
  a.wire(s, v);
  a.wire(v.out('ok'),      success);
  a.wire(v.out('invalid'), failure);
});

const flowB = activity((a) => {
  const s = a.entry('in');
  const { success, failure } = a.standardExits();
  const v1 = a.addNode('preflight', validateNode);   // same instance
  const v2 = a.addNode('recheck',   validateNode);   // same instance again
  a.wire(s, v1);
  a.wire(v1.out('ok'),       v2);
  a.wire(v1.out('invalid'),  failure);
  a.wire(v2.out('ok'),       success);
  a.wire(v2.out('invalid'),  failure);
});

flowA.compile();   // compiles validateNode once
flowB.compile();   // validateNode already compiled — no-op
```

### 9.9 Graph error vs domain error

```js
const def = activity((a) => {
  const start    = a.entry('in');
  const success  = a.exit('success');
  const stepNode = a.addNode('step',
    node(() => 'okk', { outputs: ['ok'] }));   // typo
  a.wire(start,            stepNode);
  a.wire(stepNode.out('ok'), success);
});

def.compile();
const typoFlow = flow('typo', def);

try {
  await typoFlow.run();
} catch (e) {
  // e instanceof RailRuntimeError
  // e.code === 'UNKNOWN_OUTPUT_AT_RUNTIME'
  // It propagates as a library-level failure — there is no
  // mechanism that catches or remaps it.
}
```

### 9.10 Cooperative cancellation

```js
const upload = activity((a) => {
  const start = a.entry('in');
  const ok = a.exit('ok');
  const cancelled = a.exit('cancelled');
  const failure = a.exit('failure');

  const validate = a.addNode('validate',
    node(validateFn, { outputs: ['ok', 'invalid'] }));
  const send     = a.addNode('send',
    node(sendFn, { outputs: ['ok', 'cancelled', 'failed'] }));
  const cleanup  = a.addNode('cleanup',
    node(cleanupFn, { outputs: ['done'] }));

  a.wire(start,                   validate);
  a.wire(validate.out('ok'),      send);
  a.wire(validate.out('invalid'), failure);
  a.wire(send.out('ok'),          ok);
  a.wire(send.out('cancelled'),   cleanup);
  a.wire(send.out('failed'),      failure);
  a.wire(cleanup.out('done'),     cancelled);
});

upload.compile();

async function sendFn(ctx, runInfo) {
  try {
    await fetch(ctx.url, { signal: runInfo.signal });
    return 'ok';
  } catch (e) {
    if (e.name === 'AbortError') return 'cancelled';
    return { output: 'failed', ctx: { ...ctx, error: e } };
  }
}

const ctrl = new AbortController();
const promise = flow('upload', upload).run(
  { url, payload }, { signal: ctrl.signal }
);
// Later, in response to user cancel:
ctrl.abort();
const r = await promise;
// r.terminus === 'cancelled'
```

### 9.11 Custom logger

```js
const lines = [];
await flow('sendMessage', sendMessage).run(initialCtx, {
  logger: (e) => lines.push(`${e.output ?? '(throw)'}\t${e.step}\t${e.duration}ms`),
});
```

### 9.12 Live tracer for a web UI

A tracer streams structured events to a web frontend over a
`BroadcastChannel` (or WebSocket, or any other transport). The
frontend renders the workflow live, highlighting the active node
as `step-start` events arrive and animating wires when
`step-end` events arrive.

```js
const channel = new BroadcastChannel('rail-trace');

await flow('sendMessage', sendMessage).run(initialCtx, {
  tracer: (event) => {
    // Forward every event to the UI; do not block the run.
    channel.postMessage(event);
  },
});
```

On the UI side:

```js
const channel = new BroadcastChannel('rail-trace');
channel.onmessage = ({ data: event }) => {
  switch (event.type) {
    case 'run-start':        resetUI(event.name); break;
    case 'step-start':       highlightNode(event.step); break;
    case 'step-end':         animateEdge(event.step, event.output); break;
    case 'step-throw':       markError(event.step, event.error); break;
    case 'activity-enter':   pushBreadcrumb(event.name); break;
    case 'activity-leave':   popBreadcrumb(); break;
    case 'activity-throw':   popBreadcrumb(); markActivityError(event.name); break;
    case 'branch-start':     activateBranch(event.branch); break;
    case 'branch-end':       completeBranch(event.branch, event.output); break;
    case 'branch-throw':     failBranch(event.branch, event.error); break;
    case 'run-end':          finalize(event.terminus); break;
    case 'run-error':        showError(event.error); break;
  }
};
```

The tracer call is synchronous; `postMessage` queues without
blocking. For transports that need backpressure (e.g.
slow-consumer WebSockets), the tracer can buffer in memory or
drop events according to the application's policy — the library
imposes nothing.

---

## 10. File layout

A single module is sufficient. Suggested layout:

```
rail.js               // public API: activity, node, parallel, merge, catching,
                      //   flow, isRailNode, exceptionCtx, isExceptionCtx,
                      //   isParallelCtx, ctxType,
                      //   RailCompileError, RailRuntimeError, RailBuildError
example.js            // runnable examples
README.md             // usage documentation
```

If implementation grows past ~700 lines, split internal helpers
into a `rail/` directory but keep the public API exported from
`rail.js`.

No build step, no bundler, no TypeScript. Plain ES modules. JSDoc
on every exported symbol. The `TracerEvent` discriminated union
(§6.8) and the tracer callback signature should be documented as
JSDoc typedefs on the `flow.run` opts to enable IDE
auto-completion for users writing tracers.

---

## 11. Implementation notes

- **Endpoint handles are frozen objects.** `Object.freeze` after
  construction. They carry private slots (e.g. a builder
  reference) to enable the synchronous
  `RailBuildError(WIRE_FROM_OTHER_BUILDER)` check inside
  `a.wire(...)`.
- **Compiled lookup table.** During Phase B of an Activity's
  compile, build a `Map<sourceKey, targetRecord>`. Run-time output
  resolution is O(1).
- **Compilation status.** Each Node carries an internal flag. Its
  `compile()` checks the flag at the top: if already compiled,
  return immediately. Otherwise validate, perform any kind-specific
  preparation, recursively compile children (Activity → sub-nodes;
  Parallel-Node → branches), set the flag at the end. `compiled()`
  returns the flag. In v1 the flag never flips back to false,
  since nodes are sealed; forward-compatibility with editing APIs
  requires that any future mutation reset the flag.
- **`now()`.** Prefer `performance.now()`; fall back to
  `Date.now()`. Round trace durations to 2 decimals.
- **Sort identification.** A value is a Rail-Node iff
  `typeof value?.railKind === 'string'`. The `isRailNode(value)`
  helper expresses this. The Builder uses sort-specific
  conditionals (`impl.railKind === 'activity'`, etc.) only where
  semantics differ across kinds. Generic operations (`compile`,
  `compiled`, `invoke`) rely on the uniform interface.
- **Step-Node implementation.** Internally a Step-Node is an
  object with `railKind: 'step'`, `inputs`, `outputs`, an
  internal `_fn`, an internal `_compiled` flag, and the three
  Node methods. Constructed by `node(fn, opts)`.
  `invoke(name, ctx, runState)` constructs the run-info object
  `{ signal: runState.shared.combinedSignal, input: runState.currentInput }`,
  calls `_fn(ctx, runInfo)`, and translates the user function's
  `StepReturn` (§4) into the invoke-contract shape:
  - String return `'foo'` → `{ output: 'foo' }`.
  - Object return `{ output, ctx? }` → forwarded as-is.
  - Anything else thrown → re-thrown (the runner's wrapper, not
    the Step-Node, decides whether to wrap into
    `RailRuntimeError(UNHANDLED_THROW)`).
  The `runInfo` object is created fresh per invocation; it is not
  retained or mutated by the runner. Future fields added to
  `runInfo` are populated here.
- **Activity implementation.** An object with
  `railKind: 'activity'`, the topology data (entry, exit
  endpoints, sub-nodes, wires), `_compiled` flag, lookup table
  built during compile, and the Node methods plus `toMermaid`.
  The `outputs` array is derived from the declared exits at seal
  time. Internal exit endpoints are kept for wire resolution; only
  the outward-facing `outputs` array is exposed on the Node
  interface. `invoke(name, ctx, runState)` increments depth, runs
  the inner step-execution loop until an exit is reached, and
  returns `{ output: <exitName>, ctx: <finalInnerCtx> }` per the
  invoke contract.
- **Parallel-Node implementation.** An object with
  `railKind: 'parallel'`, fixed `outputs: ['done']`, the
  `branches` map, `_compiled` flag, and the Node methods.
  `compile()` recursively compiles each branch.
  `invoke(name, ctx, runState)` uses `Promise.allSettled` with
  internal abort linkage, then returns
  `{ output: 'done', ctx: <parallel-results-ctx> }`.
- **`catching(...)` implementation.** Validates that the input is
  a Step-Node (else `RailBuildError(CATCHING_REQUIRES_STEP)`).
  Computes the union of original outputs and mapping values
  (deduplicated, ordered: original first, mapping targets after).
  Returns a fresh Step-Node object that holds a reference to the
  inner step and to the mapping. Its `invoke(name, ctx, runState)`
  calls `inner.invoke(name, ctx, runState)` inside `try`/`catch`;
  on a thrown exception, looks up `e.name` in the mapping —
  `RailRuntimeError` and `RailCompileError` are re-thrown
  unchanged (they are graph errors, not domain failures), other
  exceptions are mapped if the name is in the mapping or
  re-thrown otherwise. `compile()` and `compiled()` delegate to
  the inner step.
- **`flow.toMermaid()` implementation.** Inspects
  `flow.node.railKind`. If `'activity'`, delegates to
  `node.toMermaid(flow.name, opts)`. Otherwise (Step-Node or
  Parallel-Node), constructs the minimal diagram described in
  §3.11: synthetic `start([in])` entry, the held node, one
  synthetic `endExit_<output>([<output>])` per declared output,
  and connecting edges. The held node is rendered with the same
  shape conventions as inside an Activity (Step-Node as
  rectangle, Parallel-Node with the parallel marker class).
- **Sub-node recognition during `addNode`.** Use
  `isRailNode(value)` plus shape check for `compile`, `compiled`,
  `invoke`. If the check fails, raise Phase A `NOT_A_NODE` at the
  containing activity's compile time. The builder records the
  attempted addition; the error surfaces in Phase A rather than
  during the builder closure to keep wiring semantics consistent
  even when nodes are malformed.
- **Run-state forking.** Sub-Activities and Parallel-branches do
  not mutate the outer run-state's per-fork slots. Instead, they
  create a fork via `const fork = { ...runState }` and then
  override per-fork slots as needed (typically
  `fork.depth = runState.depth + 1`). The shared sub-object
  (`runState.shared`) is preserved across the spread because
  spread copies object values by reference. The outer's
  run-state is therefore unaffected by anything the inner does
  to per-fork slots — including in throw paths, where the fork
  simply goes out of scope. This eliminates the need for
  symmetric increment/decrement around `inner.invoke(...)`.
- **Sub-activity trace embedding.** When the runner enters a
  sub-activity, it (a) creates a fork with `depth + 1`,
  (b) wraps the logger so each inner `TraceEntry.step` is
  prefixed with the compound node's name + `.`. Inner entries
  are appended live with the fork's depth; the compound entry is
  appended after `inner.invoke(...)` returns, using the outer's
  unchanged `runState.depth` value.
- **Parallel branch forking.** The Parallel-Node creates one fork
  per branch before launching the branch's invocation. Each
  fork carries its own `depth` and `currentInput`; all forks
  share the same `runState.shared` (counter, signals, logger,
  tracer, flow name, maxSteps). This is the mechanism that
  makes interleaved branch `await`s safe.
- **Stateless flow object.** The `flow(name, node)` factory
  returns a plain object whose `run`, `toMermaid`, `name`, and
  `node` are its complete surface. Run-time data lives only in
  the closure of `run(...)`. The same flow object can be
  invoked concurrently any number of times. There is no instance
  flag, no lock, no internal state to guard.
- **Internal abort linkage in `parallel`.** The Parallel-Node
  installs an internal `AbortController` whose signal is folded
  into the combined cancellation signal that the runner exposes
  to each branch's steps via `runInfo.signal`. If a branch raises
  a `RailRuntimeError`/`RailCompileError`, the internal
  controller aborts (causing siblings to wind down via
  cooperative cancellation), `Promise.allSettled` resolves, and
  the original error is re-thrown.
- **Tracer dispatch.** The runner calls
  `runState.shared.tracer(event)` synchronously at each event
  point (§6.8). When `opts.tracer` is unset,
  `runState.shared.tracer` is a no-op function rather than
  `undefined`, so dispatch sites need no null check. Each call
  is wrapped: if the tracer throws, the wrapper raises
  `RailRuntimeError(TRACER_FAILED)` with the original error as
  `cause`. Event objects are created fresh per event; the
  library does not retain references after the call returns,
  but documents that tracers must treat the events as read-only
  to keep the door open for object reuse in future versions.
  Timestamps are computed via `performance.now() - runStartTime`
  to give run-relative milliseconds. The `run-start` event is
  emitted with `ts: 0` before any other event; the runner
  records `runStartTime` at that moment.

---

## 12. Acceptance criteria

The implementation is considered done when:

1. The example from §9.2 runs successfully, producing a correct
   `RunResult` for inputs that hit each named exit (success,
   failure via validate-invalid, failure via encrypt-noKeys,
   failure via send-net5xx with thrown `NetworkError`).
2. The example from §9.3 (sub-activity) runs, the outer's
   `compile()` recursively compiles the inner (if uncompiled),
   and the outer trace contains inner steps with the compound
   node's name as prefix, plus a final compound entry.
3. The example from §9.5 (parallel + evaluate) runs and produces
   correct outputs for both happy-path (both branches success)
   and failure-path (one branch fails) cases. Branch-level
   structural errors (e.g. an unwired output in a branch
   activity) surface at `loadProfileAndKeys.compile()` time, not
   at runtime.
4. The example from §9.6 (`exceptionCtx` + downstream evaluator)
   runs. The ctx passed to `recover` satisfies
   `isExceptionCtx(ctx) === true` and has the typed-ctx form
   `{ __type: 'exception', inputCtx, error }`. The wire from
   `op.out('failed')` to `recover` is a normal solid edge — no
   throws-mapping mechanism is involved.
5. The example from §9.7 (top-level Step-Node) runs successfully
   through a flow.
6. The example from §9.8 (reuse under multiple names)
   demonstrates that `validateNode` is compiled exactly once
   despite being added under multiple names in two activities.
7. The example from §9.9 demonstrates that a step throwing an
   exception (or returning an unknown output name) propagates as
   `RailRuntimeError`. There is no library mechanism that
   intercepts this.
8. The example from §9.10 demonstrates cooperative cancellation:
   `opts.signal` aborted during the run leads to
   `terminus: 'cancelled'` and a clean `RunResult`. The signal is
   delivered to step functions via `runInfo.signal` (the second
   parameter); it is not present on the ctx. A step that takes
   only `(ctx)` continues to work.
9. Multi-input steps receive `runInfo.input` correctly: a step
   declared with `inputs: ['retry', 'skip']`, activated via a
   wire to `nodeHandle.in('retry')`, sees `runInfo.input ===
   'retry'`. Activated via `.in('skip')`, sees `'skip'`.
   Single-input steps (default `inputs: ['in']`) always see
   `runInfo.input === 'in'`. A top-level Step-Node sees its
   first declared input (typically `'in'`).
10. The `catching(stepNode, mapping)` helper produces a Step-Node
    with the union of original outputs and mapping targets
    (deduplicated, original-first ordering). At runtime, it
    delegates to the inner step and translates thrown exceptions
    whose `e.name` matches a key in `mapping` into the mapped
    output. Exceptions whose name is not in the mapping
    propagate (becoming `RailRuntimeError(UNHANDLED_THROW)`).
    `RailRuntimeError` and `RailCompileError` thrown from the
    inner step propagate unchanged. The §9.2 example using
    `catching` runs and resolves `NetworkError` to `'net5xx'`,
    `AbortError` to `'cancelled'`. Passing an Activity or
    Parallel-Node to `catching` raises
    `RailBuildError(CATCHING_REQUIRES_STEP)`.
11. Calling `nodeHandle.out('typo')` (or `.in('typo')`) for an
    undeclared port raises `RailBuildError(UNKNOWN_PORT)`
    synchronously at the call site.
12. `a.wire(src, tgt)` with an exit handle as `src` (or an entry
    handle as `tgt`) raises `RailBuildError(INVALID_WIRE_DIRECTION)`
    synchronously at the wire-call site.
13. `a.wire(src, multiInputNodeHandle)` with no `.in(...)` selector
    raises `RailBuildError(AMBIGUOUS_NODE_INPUT)` synchronously
    when the target node has multiple inputs.
14. `a.wire(...)` with a handle returned by a different
    activity's builder raises
    `RailBuildError(WIRE_FROM_OTHER_BUILDER)` synchronously.
15. Constructing `flow(name, node)` with `node.compiled()
    === false` raises `RailBuildError(NODE_NOT_COMPILED)`.
16. Constructing `flow(name, value)` where
    `isRailNode(value)` is false raises
    `RailBuildError(NOT_A_NODE)`.
17. Constructing `flow(name, node)` with a non-string or
    empty `name` raises `RailBuildError(INVALID_FLOW_NAME)`.
18. `addNode` rejects non-node values with Phase A `NOT_A_NODE`.
19. `Activity.compile()` correctly reports each error code in §7
    with a minimal failing definition. Errors within a phase are
    collected; phases short-circuit. Unwired node-inputs are
    **not** an error (asymmetric to `UNWIRED_OUTPUT`).
20. `compile()` is idempotent: calling it multiple times on the
    same Activity is a no-op after the first successful call;
    `compiled()` returns true after the first.
21. The same Activity instance passed to multiple `addNode` calls
    (in one or more outer activities) is compiled exactly once,
    as demonstrated in §8.3 and §9.8.
22. Typed-ctx helpers behave correctly:
    - `exceptionCtx(err, ctx)` returns
      `{ __type: 'exception', inputCtx: ctx, error: err }`.
    - `isExceptionCtx(v)` returns `true` iff
      `v?.__type === 'exception'`.
    - `isParallelCtx(v)` returns `true` iff
      `v?.__type === 'parallel-results'`.
    - `ctxType(v)` returns `v.__type` if it is a string, else
      `undefined`.
    - The `parallel(...)` step output ctx satisfies
      `isParallelCtx(...) === true`.
    - A ctx produced by `exceptionCtx(err, inputCtx)` satisfies
      `isExceptionCtx(...) === true`.
23. Kill switch: when `opts.killSignal` is aborted, the run
    rejects with `RailRuntimeError(KILLED)` before the next node
    starts. The error carries the trace and the flow name.
24. Sub-activity run-state sharing: a sub-activity's steps count
    toward the outer `maxSteps`; `killSignal` aborts both inner
    and outer; `runInfo.signal` is the same combined signal in
    both runs. `maxSteps` is run-global, including across
    parallel branches; the synchronous, single-threaded counter
    increment ensures deterministic enforcement.
25. Trace `depth` field is correctly populated: top-level steps
    have `depth: 0`; steps in a one-level sub-activity have
    `depth: 1`; doubly-nested have `depth: 2`. The compound entry
    appended after a sub-activity returns carries the *outer*
    depth. Parallel-Nodes themselves do not increment depth, but
    if a branch is an Activity, its inner steps are one level
    deeper than the parallel-node's own depth.
26. `flow.toMermaid()` for the §9.2 flow produces parseable
    Mermaid output labelled `'sendMessage'`, with all nodes and
    forward edges labelled by output-port name. The `send` node
    (a `catching`-wrapped step) appears as a single rectangle
    with three outgoing edges (`ok`, `net5xx`, `cancelled`); the
    wrapping is invisible in the diagram. There are no dotted
    edges; all edges are solid.
27. `flow.toMermaid()` for §9.3's outer renders the sub-activity
    node as a subroutine shape with class `subActivity`, not
    expanded.
28. `flow.toMermaid()` for §9.5 renders the Parallel-Node with a
    distinct shape and class `parallelNode`, not expanded.
29. `flow.toMermaid()` for §9.7 (top-level Step-Node) produces a
    minimal diagram: a synthetic entry, the step node, and one
    synthetic exit per declared output, with edges connecting
    them.
30. The default logger emits one line per executed step in
    execution order, prefixed with the flow name. Tag is `OK`
    for a normal output (`threw === false`), and `XX` for a step
    that triggered a `RailRuntimeError` (uncaught throw or
    unknown output). The step name is indented by two spaces per
    level of `entry.depth`. The line includes output (or
    library-error code for `XX`), duration, and error message if
    any.
31. When `opts.tracer` is provided, the runner emits the events
    described in §6.8 in the documented order. Each lifecycle
    scope emits exactly one start event and exactly one end
    event (success or failure):
    - **Run:** `run-start` first (with `ts: 0`), then `run-end`
      (with `terminus` and final ctx) on success, or `run-error`
      on `RailRuntimeError`.
    - **Step:** `step-start` and either `step-end` (with output
      and duration) or `step-throw` (with the original thrown
      value and duration) around every invoked node.
    - **Activity:** `activity-enter` (inner depth) and either
      `activity-leave` (outer depth, exit name) on success or
      `activity-throw` (outer depth, propagating
      `RailRuntimeError`/`RailCompileError`, duration) on
      failure.
    - **Branch:** `branch-start` and either `branch-end` (with
      branch's terminal output) or `branch-throw` (with
      propagating error and duration) around each parallel
      branch's invocation.
    All events carry `depth` and `ts` fields. The tracer is
    called synchronously; if it throws, the runner raises
    `RailRuntimeError(TRACER_FAILED)` carrying the original
    error as `cause`. When no tracer is provided, no events are
    emitted (zero overhead beyond a no-op call).
32. **Stateless flow and reentrancy.** A flow object created
    by `flow(...)` carries no run-time state of its own.
    Multiple concurrent `run(...)` invocations on the same
    flow object run independently, each with its own
    run-state, without interference. A tracer that calls
    `flow.run(...)` (on the same flow or a different one)
    during event handling starts an independent new run; events
    from the new run are delivered to its own tracer (per its
    own `opts`), not the outer one.
33. **Per-fork run-state isolation.** When two Activity
    branches in a Parallel-Node interleave their `await`s,
    their `depth` and `currentInput` values are independent —
    a step in branch A sees its own `runInfo.input`, not
    branch B's, and trace entries / tracer events carry the
    correct branch-local depth. The shared sub-object (counter,
    signals, logger, tracer, flow name, maxSteps) is observed
    consistently by all branches.
34. **Naming inside parallel branches.** A trace entry produced
    by an inner step of an Activity branch named `branchA`
    inside a Parallel-Node named `fan` has its `step` field
    set to `fan.branchA.<inner-step>`. The branch's compound
    entry is `fan.branchA`, and the parallel-node's own entry
    is `fan`. This convention guarantees uniqueness across
    multiple Parallel-Nodes that happen to use the same branch
    keys.
35. The library has no runtime dependencies (`package.json` has
    no `dependencies`).
36. All public symbols are documented with JSDoc that includes
    types.

---

## 13. Out of scope (future work)

- Cycles with explicit opt-in.
- Editing API: methods to add/remove nodes or wires after the
  builder closure has returned. The `compiled()` flag is designed
  to invalidate when a node is mutated; v1 does not introduce the
  mutation API.
- Mermaid expansion of sub-activities and Parallel-Nodes
  (rendering inner graphs as Mermaid `subgraph` blocks with
  disambiguated IDs).
- A devtool overlay that visualises a live run on top of the
  Mermaid graph (the tracer hook in §6.8 provides the data
  stream; the overlay UI itself is out of scope for the library).
- First-class node-handle methods beyond `out()`/`in()` (e.g.
  `validate.before(encrypt)` as syntactic sugar for wiring).
- Additional node kinds beyond `'step'`, `'activity'`,
  `'parallel'` (e.g. `'loop'`). The `railKind`-based
  identification leaves room for these.
- `catching(...)` for Activity and Parallel-Node inputs (v1
  accepts only Step-Nodes).

---

## 14. Glossary

- **Node** — abstract base concept for elements in a graph. A
  plain object with `railKind: string`, `compile()`, `compiled()`,
  `invoke(name, ctx, runState)`. Concrete kinds: Step-Node,
  Activity, Parallel-Node. Has no intrinsic name.
- **Step-Node** (`railKind: 'step'`) — node kind that wraps a
  user function. Created by `node(fn, opts)`.
- **Activity** (`railKind: 'activity'`) — node kind with internal
  topology (sub-nodes, wires, entry, exits). Built with
  `activity(builderFn)`. Both runnable as a top-level (via
  a flow) and embeddable as a sub-node.
- **Parallel-Node** (`railKind: 'parallel'`) — node kind that
  runs branches concurrently. Built with `parallel(branches)`.
  Single output `'done'`; produces a typed ctx of the form
  `{ __type: 'parallel-results', inputCtx, results }`.
- **Flow** — factory `flow(name, node)` returning a runtime
  wrapper that holds a top-level name and one node, providing
  top-level execution via `run(ctx, opts)`. Plain object, not a
  class — `new` is not used. **Stateless**: all run-time data
  lives in the closure of `run(...)`. Not a Node. The term
  follows BPMN's Sequence Flow / Process Flow vocabulary; a
  flow is internally still a graph of nodes connected by wires.
- **Run** — one execution of a flow, started by `flow.run(...)`.
  Each run allocates its own run-state in its own closure;
  multiple runs of the same flow are independent.
- **Compile** — validates a node (Phases A–C for activities;
  configuration validation for steps; recursive sub-compile for
  activities and parallel-nodes), sets `compiled()` to true.
  Idempotent.
- **Port** — a named input or output of a node.
- **Endpoint handle** — an opaque value, returned by builder
  methods or `nodeHandle.out()`, used in `wire(...)` calls.
- **Wire** — a connection from a source endpoint handle (output
  side) to a target endpoint handle (input side).
- **Convergence** — multiple wires ending at the same node-input.
  Means "no matter from where, continue here". Not a parallel
  construct.
- **Track** — colloquial term for a path through the graph.
- **Output** — the name a node's `invoke` returns (an element of
  `node.outputs`). The runner uses it to resolve the next wire.
  Universal across all node kinds.
- **Terminus** — caller-facing: the `output` produced by the
  top-level node, exposed on `RunResult.terminus` (§3.6). Inside
  the library every `invoke` produces an `output`; only at the
  flow.run boundary does the final output become the terminus.
- **Trace** — the ordered list of `TraceEntry` records produced
  by a run. Each entry has `step`, `output`, `duration`, `depth`,
  `threw`, and an optional `error` field. The `depth` field
  counts sub-activity nesting (0 for top-level).
- **Logger** — `opts.logger`, a synchronous callback invoked
  once per step **after** the step finishes, with the same
  `TraceEntry` that is appended to the trace. Default writes
  to `console.log`. See §6.6.
- **Tracer** — `opts.tracer`, an optional synchronous callback
  invoked at multiple points during the run with structured
  events. Each lifecycle scope emits a start event and either
  a success-end or a failure-end event:
  - Run: `run-start`, `run-end`, `run-error`.
  - Step: `step-start`, `step-end`, `step-throw`.
  - Activity: `activity-enter`, `activity-leave`,
    `activity-throw`.
  - Branch (in a Parallel-Node): `branch-start`, `branch-end`,
    `branch-throw`.
  Intended for live observation (e.g. real-time UI). Default:
  no tracer. See §6.8.
- **TracerEvent** — discriminated-union event type passed to the
  tracer callback. Each event has `type`, `ts` (run-relative
  milliseconds), `depth`, plus per-type fields. See §6.8.
- **ctx (Run-Context)** — the object passed to each step and
  threaded through the run. Owned by the programmer; the library
  does not write into it. Steps that return a `ctx` field
  replace the running ctx (no merge).
- **Run-info** — the second parameter passed to step functions:
  `(ctx, runInfo) => ...`. Carries library-side per-run
  information that is not domain data. In v1: `{ signal?, input }`
  — the combined cancellation signal and the name of the input
  port through which the step was activated. The shape is
  forward-stable; fields may be added in future versions but not
  removed. See §4.
- **Typed ctx** — a ctx object marked with `__type: '<name>'`,
  declaring its shape. Library uses `'exception'` and
  `'parallel-results'`. User code may introduce its own types.
  See §3.12.
- **Exception ctx** — typed ctx of the form
  `{ __type: 'exception', inputCtx, error }`. Produced by
  `exceptionCtx(...)` (§3.12) when user code wants to forward a
  caught exception as structured data through the graph. Detected
  via `isExceptionCtx(...)`. The library never produces this on
  its own.
- **Parallel-results ctx** — typed ctx of the form
  `{ __type: 'parallel-results', inputCtx, results }`. Produced
  by the parallel node. Detected via `isParallelCtx(...)`.
- **Run-state** — internal, per-run record holding step counter,
  current sub-activity depth, combined cancellation signal, raw
  `killSignal`, logger, top-level flow name, and `currentInput`
  (the input port for the next Step-Node invoke). Allocated by
  `flow.run(...)` and shared with every node invoked during the
  run. Not directly visible to step implementations; the run-info
  is the step-visible projection.
- **Domain error** — an expected, business-relevant failure
  produced by a step. **Always** modelled as a named output. The
  library has no exception-mapping mechanism; steps that interact
  with throwing code use `try`/`catch` themselves (§4.1).
- **Graph error** — a failure of the graph contract or library
  invariants. Always propagates as `RailRuntimeError`. Any
  exception thrown out of a step that the step itself does not
  catch becomes `RailRuntimeError(UNHANDLED_THROW)`.
