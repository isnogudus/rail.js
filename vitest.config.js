/**
 * Vitest configuration.
 *
 * Coverage is scoped to the actual library files (rail.js + rail/*) so
 * the report isn't drowned by examples/, demo code, and the bundled
 * copies under site/lib/.
 */
export default {
  test: {
    coverage: {
      provider: 'v8',
      include: ['rail.js', 'rail/**/*.js'],
      reporter: ['text', 'text-summary'],
    },
  },
};
