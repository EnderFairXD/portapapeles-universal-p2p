import { defineConfig } from 'vitest/config';

// beforeAll compila el ejemplo headless de Rust: plazos largos (Ruling R5).
export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
