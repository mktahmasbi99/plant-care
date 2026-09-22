import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://127.0.0.1:8000', trace: 'on-first-retry' },
  webServer: {
    command: 'python -m uvicorn app.main:app --app-dir ../backend --host 127.0.0.1 --port 8000',
    env: { TZ: 'Europe/Warsaw', PLANT_CARE_DB: '/tmp/plant-care-e2e.sqlite3' },
    reuseExistingServer: !process.env.CI,
  },
  projects: [{ name: 'phone', use: { ...devices['iPhone 15'], browserName: 'chromium' } }],
})
