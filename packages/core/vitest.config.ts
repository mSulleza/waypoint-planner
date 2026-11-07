import { defineConfig } from 'vitest/config'

// The property tests walk generated households and are CPU-bound: about 2 s on a fast machine,
// 4 to 5 s on a GitHub-hosted runner, so vitest's 5 s default fails them at random.
export default defineConfig({
  test: { environment: 'node', include: ['test/**/*.test.ts', 'src/**/*.test.ts'], testTimeout: 30_000 },
})
