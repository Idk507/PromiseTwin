import { defineConfig } from 'vitest/config';

// A cold transform cache once pushed a module import past the default 10 s hook timeout (a false
// failure, not a logic fault). A larger hook timeout removes that flake without hiding real hangs.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    hookTimeout: 30000,
    testTimeout: 30000,
  },
});
