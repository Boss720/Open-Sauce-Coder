import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/renderer/src/lib/__tests__/**/*.test.ts', 'src/main/__tests__/**/*.test.ts'],
    globals: false,
    testTimeout: 15000,
    hookTimeout: 15000,
    coverage: {
      provider: 'v8',
      include: ['src/main/**', 'src/renderer/src/lib/**'],
      exclude: ['**/__tests__/**'],
      reporter: ['text', 'json-summary'],
      /**
       * M2.6 coverage gate. Set below the measured numbers so an unrelated PR cannot trip
       * it on rounding, and meant to be ratcheted upward as coverage lands — never lowered
       * to make a red build pass.
       *
       * Measured 2026-08-05, after M2.5 compareSlice + imagesSlice: statements 72.54,
       * branches 67.64, functions 73.83, lines 75.53.
       */
      thresholds: {
        statements: 70,
        branches: 64,
        functions: 70,
        lines: 73
      }
    }
  }
})
