import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const extension = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(extension, '..', '.tmp', 'e2e', `popup-${Date.now()}`);
await mkdir(output, { recursive: true });
const context = await chromium.launchPersistentContext(join(output, 'profile'), {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const id = worker.url().split('/')[2];
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/dist/popup/popup.html`);
  await expect(page.locator('#toggle')).toHaveText('Turn on Captions');
  await expect(page.locator('#service-state')).toHaveText('Captions off');
  await page.locator('#info').click();
  await expect(page.locator('#model-detail')).toContainText('Backend: ready', { timeout: 10000 });
  await expect(page.locator('#model-detail')).toContainText('Sidecar: ready');
  await expect(page.locator('#model-detail')).toContainText('Model: tiny');
  await expect(page.locator('#model-detail')).toContainText('Mode: windowed');
  console.log(`POPUP_HEALTH_VERIFIED: ${await page.locator('#model-detail').textContent()}`);
  await page.screenshot({ path: join(output, 'service-info.png') });
  await page.locator('#info').click();
  await expect(page.locator('#model-info')).toBeHidden();
  console.log(`POPUP_SMOKE_PASSED: live service info opens and closes; screenshot at ${output}`);
} finally {
  await context.close();
}
