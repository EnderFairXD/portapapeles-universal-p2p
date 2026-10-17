import { defineConfig } from 'vitest/config';

// Solo módulos puros (sin React Native): se ejecutan en Node.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
