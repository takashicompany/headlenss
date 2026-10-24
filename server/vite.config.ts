import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/',
  plugins: [react()],
  root: 'src/web',
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        ws: true,
      },
      // セッションの成果物 (プレビュータブ) はサーバが配信するので dev でも通す
      '/preview': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
