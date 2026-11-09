import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const target = `http://127.0.0.1:${process.env.WORKBENCH_PORT ?? 47800}`;

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': target,
      '/ws': { target, ws: true },
    },
  },
  test: { root: '.', include: ['server/**/*.test.ts', 'web/src/**/*.test.ts'] },
});
