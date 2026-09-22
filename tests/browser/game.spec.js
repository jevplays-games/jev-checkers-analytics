import { test,expect } from '@playwright/test';
test('local play, real Web Worker, analytics, replay and export',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/');
 await expect(page.locator('#board .piece')).toHaveCount(24);
 const ratio=await page.locator('#board .piece').first().evaluate(e=>e.getBoundingClientRect().width/e.parentElement.getBoundingClientRect().width);expect(ratio).toBeGreaterThan(.65);
 await page.locator('#new-game').click();await expect(page.locator('#turn-status')).toContainText('Your turn');
 await page.locator('#board [data-square="9"]').click();await page.locator('#board [data-square="13"]').click();
 await expect(page.locator('#metric-turns')).toHaveText('2');await expect(page.locator('#turn-status')).toContainText('Your turn');
 await page.locator('#decisions-tab').click();expect(await page.locator('#candidate-table tbody tr').count()).toBeGreaterThan(0);
 await page.locator('#verify').click();await expect(page.locator('#audit-status')).toContainText('Integrity verified');
 const downloadPromise=page.waitForEvent('download');await page.locator('#export').click();const download=await downloadPromise;expect(download.suggestedFilename()).toMatch(/\.zip$/);
 await page.reload();await expect(page.locator('#metric-turns')).toHaveText('2');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);
});
test('keyboard navigation and reduced motion',async({page})=>{
 await page.emulateMedia({reducedMotion:'reduce'});await page.goto('/');await page.locator('#new-game').click();
 await page.locator('#board [data-square="9"]').focus();await page.keyboard.press('Enter');await page.keyboard.press('Escape');
 expect(await page.locator('#board .selected').count()).toBe(0);await page.keyboard.press('ArrowUp');
 expect(await page.evaluate(()=>!!document.activeElement.closest('#board'))).toBe(true);
});
