/**
 * Jest, by hand, because this package ships no framework config of its own.
 *
 * The transform is Babel rather than native ESM for one reason: `babel-jest`
 * compiles the suite to CommonJS, and a file containing `import.meta` then fails
 * to transform at all. `src/core/registry.js` and `src/index.js` both used it and
 * both are now written without it (see the comment above `ownPath` in each), which
 * is what makes `src/index.js` reachable from a test at all.
 */
module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.(js|jsx)$': 'babel-jest',
  },
  testMatch: ['**/__tests__/**/*.test.js'],
  /**
   * Everything under `src/`, `src/index.js` included.
   *
   * It used to carry `'!src/index.js'` with the comment "it connects stdio on
   * import, so it is covered by the end-to-end test that drives it as a child
   * process". That was half true and the half that was true mattered more than
   * the exclusion: a child process's coverage is never collected, so the largest
   * file in the package -- the request handlers, the error formatting, the process
   * wiring -- was excluded from the number and the number was never wrong about
   * it. It is back in, and `__tests__/package_entry.test.js` is what covers it.
   */
  collectCoverageFrom: [
    'src/**/*.js',
  ],
  /**
   * A floor, not a target.
   *
   * Set just under what the suite actually reaches, so a regression that removes
   * a test is a failure rather than a quieter number. CI uploads the report as an
   * artifact, so the trend is visible without this having to be aggressive.
   *
   * Deliberately `lines` only, not `statements`/`functions`/`branches`: the
   * untouched-elsewhere files include long, largely-defensive branches (error
   * classification, format fallbacks) where a percentage threshold would push
   * towards tests that assert a shape rather than a behaviour.
   */
  coverageThreshold: {
    global: {
      lines: 85,
    },
  },
  coverageReporters: ['text', 'text-summary', 'lcov', 'json-summary'],
  // Timers are asserted on with real durations, so give them room.
  testTimeout: 20000,
};
