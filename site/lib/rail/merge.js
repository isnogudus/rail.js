/**
 * `merge(stepFn)` — convenience wrapper. See spec §3.8.
 *
 * Wraps a step that returns only the *patch* it wants to add to the
 * running ctx, rather than a full replacement. The wrapper spreads
 * the input ctx around the patch.
 */

/**
 * @typedef {string | { output: string, patch?: object }} MergeStepReturn
 */

/**
 * Wraps a patch-style step into a normal step function.
 *
 * The returned function preserves the input ctx and shallow-merges
 * the patch into it. Intended to be passed as the `fn` argument to
 * `node(...)`:
 *
 *     node(merge(stepFn), { outputs: [...] })
 *
 * @param {(ctx: object, local?: object, runInfo?: object) => MergeStepReturn | Promise<MergeStepReturn>} stepFn
 */
export function merge(stepFn) {
  return async function mergedStep(ctx, local, runInfo) {
    const result = await stepFn(ctx, local, runInfo);
    if (typeof result === 'string') return result;
    if (result && typeof result === 'object') {
      if ('patch' in result && result.patch !== undefined) {
        return { output: result.output, ctx: { ...ctx, ...result.patch } };
      }
      return { output: result.output, ctx };
    }
    return result;
  };
}
