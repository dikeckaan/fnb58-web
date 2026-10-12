import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  server: { port: 5858, strictPort: false },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
