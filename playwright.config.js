import { defineConfig,devices } from '@playwright/test';
export default defineConfig({testDir:'./tests/browser',fullyParallel:false,use:{baseURL:'http://127.0.0.1:8787',trace:'retain-on-failure'},
 webServer:{command:'npm start',url:'http://127.0.0.1:8787/api/health',reuseExistingServer:!process.env.CI},
 projects:[{name:'desktop',use:{...devices['Desktop Chrome']}},{name:'mobile',use:{...devices['Pixel 7']}}]});
