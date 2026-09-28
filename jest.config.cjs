module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.(js|jsx)$': 'babel-jest',
  },
  testMatch: ['**/__tests__/**/*.test.js'],
  // src/index.js is excluded: it connects stdio on import, so it is covered by
  // the end-to-end test that drives it as a child process.
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/index.js',
  ],
  // Timers are asserted on with real durations, so give them room.
  testTimeout: 20000,
};
