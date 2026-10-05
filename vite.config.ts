import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // itch.io / GitHub Pages のサブパスに置けるよう相対パスで出力する
  base: './',
  worker: { format: 'es' },
  build: {
    // 決定性チェック用のページも一緒に出力する(Playwright のブラウザ間テストで使う)
    rollupOptions: { input: { main: 'index.html', determinism: 'determinism.html' } },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
