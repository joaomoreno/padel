// @ts-check
// Verifies that the service worker caches the app so it opens and works offline.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = {
  '/': { type: 'text/html; charset=utf-8', body: fs.readFileSync(path.join(ROOT, 'index.html')) },
  '/index.html': { type: 'text/html; charset=utf-8', body: fs.readFileSync(path.join(ROOT, 'index.html')) },
  '/sw.js': { type: 'application/javascript; charset=utf-8', body: fs.readFileSync(path.join(ROOT, 'sw.js')) },
};

/** Start a local HTTP server serving index.html and sw.js on an ephemeral localhost port. */
function startServer() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const urlPath = (req.url || '/').split('?')[0];
      const file = FILES[urlPath];
      if (!file) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': file.type });
      res.end(file.body);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = /** @type {import('net').AddressInfo} */ (server.address());
      resolve({ server, origin: `http://127.0.0.1:${addr.port}` });
    });
  });
}

test('works offline after first online visit', async ({ context, page }) => {
  // Block external hosts (e.g. Google Fonts) so the test stays self-contained.
  await context.route('**/*', r => {
    const u = r.request().url();
    return u.startsWith('http://127.0.0.1:') ? r.continue() : r.abort();
  });

  const { server, origin } = await startServer();
  try {
    // 1. First visit while online: start a tournament and wait for the service worker to take control.
    await page.goto(origin + '/');
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
      }
    });

    await page.click('[data-act=sample]');
    await page.click('button[type=submit]');
    await expect(page.locator('.rnd')).toHaveText('Round 1');
    const tournamentUrl = page.url();
    expect(tournamentUrl).toContain('#');

    // 2. Go offline (and shut down the server to be certain nothing comes from the network).
    await context.setOffline(true);
    await new Promise(resolve => server.close(resolve));

    // 3. Reloading the active tournament URL offline restores the board and stays interactive.
    await page.reload();
    await expect(page.locator('.rnd')).toHaveText('Round 1');
    await page.locator('.court').first().locator('.half[data-side="0"]').click();
    await page.click('[data-act=pick][data-v="15"]');
    await expect(page.locator('.court').first().locator('.half[data-side="0"] .scr')).toHaveText('15');

    // 4. Opening the root URL fresh in a new tab while offline loads the setup view.
    const fresh = await context.newPage();
    await fresh.goto(origin + '/');
    await expect(fresh.locator('[data-act=sample]')).toBeVisible();
    await fresh.close();
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
});
