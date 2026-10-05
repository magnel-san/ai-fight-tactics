import { defineConfig, devices } from '@playwright/test';

// 本番ビルドを vite preview で配信し、3つのブラウザで決定性テストを行う
export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  fullyParallel: true,
  reporter: 'list',
  use: { baseURL: 'http://localhost:4317' },
  webServer: {
    // 古いビルドを配信している別のサーバーを使わないよう、毎回ビルドして専用のポートで配信する
    command: 'npm run build && npx vite preview --port 4317 --strictPort',
    url: 'http://localhost:4317',
    reuseExistingServer: false,
    timeout: 180_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
