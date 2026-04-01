module.exports = {
  testMatch: [
    '<rootDir>/tests/unit/**/*.test.js',
    ...(process.env.RUN_INTEGRATION === 'true'
      ? ['<rootDir>/tests/integration/**/*.test.js']
      : []),
  ],
  testTimeout: 15000,
  collectCoverageFrom: [
    'config.js',
    'summarizer.js',
    'shared-memory.js',
    'debate-engine.js',
    'preflight.js',
  ],
  coverageThreshold: {
    global: { lines: 55 },
  },
};
