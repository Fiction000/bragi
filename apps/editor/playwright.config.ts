import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './test/e2e', timeout: 30000, fullyParallel: false, reporter: 'list', use: { browserName: 'chromium', headless: true } });
