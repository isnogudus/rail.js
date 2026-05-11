/**
 * `catching(stepNode, mapping)` — exception-to-output wrapper.
 * See spec §3.13.
 *
 * Produces a new Step-Node that delegates to `stepNode.invoke` and,
 * on a thrown exception, looks up `e.name` in `mapping` to produce
 * a named output instead. `RailRuntimeError` and `RailCheckError`
 * are never mapped — they propagate as graph errors.
 */

import { RailBuildError, RailCheckError, RailRuntimeError } from './errors.js';

/**
 * @param {object} stepNode      A Step-Node (`railKind: 'step'`).
 * @param {Record<string, string>} mapping  Map of `errorName -> outputName`.
 * @returns {object} A new Step-Node with extended outputs.
 */
export function catching(stepNode, mapping) {
  if (stepNode?.railKind !== 'step') {
    throw new RailBuildError(
      'CATCHING_REQUIRES_STEP',
      `catching(): first argument must be a Step-Node (railKind 'step'); got ${stepNode?.railKind ?? typeof stepNode}`
    );
  }
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    throw new TypeError(
      'catching(): second argument must be an object map { errorName: outputName }'
    );
  }

  // Extended outputs: original first (declaration order), then mapping
  // values (insertion order), deduplicated.
  const extendedOutputs = [];
  const seen = new Set();
  for (const o of stepNode.outputs) {
    if (!seen.has(o)) {
      seen.add(o);
      extendedOutputs.push(o);
    }
  }
  for (const key of Object.keys(mapping)) {
    const o = mapping[key];
    if (typeof o === 'string' && !seen.has(o)) {
      seen.add(o);
      extendedOutputs.push(o);
    }
  }

  /** @type {any} */
  const wrapper = {
    railKind: 'step',
    inputs: stepNode.inputs.slice(),
    outputs: extendedOutputs,
    _inner: stepNode,
    _mapping: mapping,

    check() {
      if (!stepNode.isChecked()) stepNode.check();
    },

    isChecked() {
      return stepNode.isChecked();
    },

    async invoke(name, ctx, runState, local) {
      try {
        return await stepNode.invoke(name, ctx, runState, local);
      } catch (e) {
        if (e instanceof RailRuntimeError || e instanceof RailCheckError) {
          throw e;
        }
        const errName = /** @type {any} */ (e)?.name;
        if (typeof errName === 'string' && Object.prototype.hasOwnProperty.call(mapping, errName)) {
          return { output: mapping[errName] };
        }
        throw e;
      }
    },
  };

  return wrapper;
}
