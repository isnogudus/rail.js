/**
 * `pin(node, entry)` — wrapper that fixes one of a multi-entry node's
 * inputs to expose a single-input view. See spec §4.1.
 *
 * `pin` is trace-transparent (§2): `_invoke` delegates directly to the
 * inner node's `_invoke` without going through `invokeNode`. It owns
 * no `local` slot of its own — the `local` it receives is passed
 * straight to the inner node.
 */

import { RailBuildError } from './errors.js';
import { isRailNode } from './util.js';

/**
 * @param {object} inner   any Rail-Node
 * @param {string} entry   one of `inner.inputs`
 * @returns {object} Rail-Node with `__rail_kind__: 'pin'`,
 *                   `inputs: ['in']`, `outputs: inner.outputs`,
 *                   `_inner: inner`.
 */
export function pin(inner, entry) {
  if (!isRailNode(inner)) {
    throw new RailBuildError('NOT_A_NODE', {
      message: `pin(node, entry): node is not a Rail-Node`,
      details: { arg: 'node' },
    });
  }
  if (typeof entry !== 'string' || !inner.inputs.includes(entry)) {
    throw new RailBuildError('UNRESOLVED_WIRE_REFERENCE', {
      message: `pin(node, entry): entry "${entry}" is not in inner.inputs [${inner.inputs.join(', ')}]`,
      details: { ref: String(entry), validInputs: inner.inputs },
    });
  }

  const node = {
    __rail_type__: 'node',
    __rail_kind__: 'pin',
    inputs: ['in'],
    outputs: inner.outputs.slice(),
    _inner: inner,
  };

  node._invoke = (_entry, ctx, local, runState, path) =>
    inner._invoke(entry, ctx, local, runState, path);

  return node;
}
