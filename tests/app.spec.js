// @ts-check
// Integration tests: they load index.html in a real browser and drive it like a user would.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const URL = 'http://padel.test/';
const NAMES18 = ['Ana', 'Bruno', 'Carla', 'Diego', 'Elena', 'Felix', 'Gina', 'Hugo', 'Iris', 'Jonas', 'Katja', 'Luca', 'Mara', 'Nico', 'Olga', 'Pablo', 'Quinn', 'Rosa'];

// Serve index.html from disk; block everything else (e.g. Google Fonts) so tests run offline.
test.beforeEach(async ({ context }) => {
  await context.route('**/*', r => r.request().url().startsWith(URL)
    ? r.fulfill({ status: 200, contentType: 'text/html', body: HTML })
    : r.abort());
});

/** @param {import('@playwright/test').Page} page */
const state = page => page.evaluate(() => JSON.parse(localStorage.getItem('padel-tourney-v1') || 'null'));

/** Start a tournament through the setup form. */
async function start(page, { names = NAMES18, points = 24, mode = 'americano', courts = 4, name = 'Friday' } = {}) {
  await page.goto(URL);
  await page.click(`[data-act=mode][data-v=${mode}]`);
  await page.click(`[data-act=pts][data-v="${points}"]`);
  for (let c = 4; c < courts; c++) await page.click('[data-act=cinc]');
  for (let c = 4; c > courts; c--) await page.click('[data-act=cdec]');
  await page.fill('#tn', name);
  await page.fill('#pl', names.join('\n'));
  await page.click('button[type=submit]');
  await expect(page.locator('.rnd')).toHaveText('Round 1');
}

/** Enter a score for every unscored court in the current round (left team gets `v`, or a function of the court index). */
async function finishRound(page, v = 10) {
  const vals = await page.evaluate(() => [...document.querySelectorAll('.court')].map((c, i) => c.querySelector('.hint') ? i : -1).filter(i => i >= 0));
  for (const i of vals) {
    await page.locator('.court').nth(i).locator('.half[data-side="0"]').click();
    await page.click(`[data-act=pick][data-v="${typeof v === 'function' ? v(i) : v}"]`);
  }
}

const standingsPts = page => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.rr')]
  .map(r => [r.querySelector('.pn').textContent, +r.querySelector('.pt').textContent])));

test.describe('setup', () => {
  test('sample-names link says how many names it fills in', async ({ page }) => {
    await page.goto(URL);
    await expect(page.locator('[data-act=sample]')).toHaveText('Fill in 16 sample names');
    await page.click('[data-act=sample]');
    expect((await page.inputValue('#pl')).split('\n')).toHaveLength(16);
  });

  test('sample-names count follows the courts setting', async ({ page }) => {
    await page.goto(URL);
    await page.click('[data-act=cdec]');
    await page.click('[data-act=cdec]');
    await expect(page.locator('[data-act=sample]')).toHaveText('Fill in 8 sample names');
  });

  test('one player per line: commas inside a line are kept', async ({ page }) => {
    await page.goto(URL);
    await page.fill('#pl', 'Smith, John\nDoe; Jane\nAna\nBruno');
    await expect(page.locator('#sum')).toContainText('4 players');
  });

  test('a single pasted line separated by commas still splits', async ({ page }) => {
    await page.goto(URL);
    await page.fill('#pl', 'Ana, Bruno; Carla, Diego');
    await expect(page.locator('#sum')).toContainText('4 players');
  });

  test('duplicate names are rejected regardless of case and spacing', async ({ page }) => {
    await page.goto(URL);
    await page.fill('#pl', '  Ana   Maria \nana maria\nB\nC');
    await expect(page.locator('#sum')).toContainText('Duplicate name');
    await page.click('button[type=submit]');
    expect(await state(page)).toBeNull();
  });

  test('needs at least 4 players', async ({ page }) => {
    await page.goto(URL);
    await page.fill('#pl', 'A\nB\nC');
    await expect(page.locator('#sum')).toContainText('add at least 4');
    await page.click('button[type=submit]');
    expect(await state(page)).toBeNull();
  });

  test('unsaved setup survives a reload and is cleared once started', async ({ page }) => {
    await page.goto(URL);
    await page.fill('#tn', 'Draft test');
    await page.fill('#pl', 'Ana\nBruno');
    await page.reload();
    await expect(page.locator('#tn')).toHaveValue('Draft test');
    await expect(page.locator('#pl')).toHaveValue('Ana\nBruno');
    await page.fill('#pl', 'Ana\nBruno\nCarla\nDiego');
    await page.click('button[type=submit]');
    expect(await page.evaluate(() => localStorage.getItem('padel-draft-v1'))).toBeNull();
    await page.reload();
    await expect(page.locator('.rnd')).toHaveText('Round 1');
  });

  test('page title follows the event and round', async ({ page }) => {
    await page.goto(URL);
    await expect(page).toHaveTitle('Padel tournament');
    await start(page, { name: 'Friday' });
    await expect(page).toHaveTitle('Friday · Round 1');
  });

  test('names with HTML are shown as text', async ({ page }) => {
    await start(page, { name: '<b>x</b>', names: ['<img src=x onerror=alert(1)>', 'B', 'C', 'D'] });
    await expect(page.locator('.top .ttl')).toHaveText('<b>x</b>');
    expect(await page.locator('img').count()).toBe(0);
  });
});

test.describe('score dialog', () => {
  test('typing a score and pressing Enter saves it and refocuses the court', async ({ page }) => {
    await start(page, { points: 21 });
    await page.locator('.court').first().locator('.half[data-side="0"]').click();
    await page.keyboard.press('1');
    await page.keyboard.press('5');
    await page.keyboard.press('Enter');
    const m = (await state(page)).rounds[0].m[0];
    expect([m.sa, m.sb]).toEqual([15, 6]);
    await expect(page.locator('.half[data-m="0"][data-side="0"]')).toBeFocused();
  });

  test('clicking the right side of a court enters that side\'s score and shows hover feedback', async ({ page }) => {
    await start(page, { points: 21 });
    const left = page.locator('.court[data-m="0"] .half[data-side="0"]');
    const right = page.locator('.court[data-m="0"] .half[data-side="1"]');
    await right.hover();
    await expect.poll(() => page.evaluate(() =>
      getComputedStyle(document.querySelector('.court[data-m="0"] .half[data-side="1"]')).backgroundColor
    )).not.toBe('rgba(0, 0, 0, 0)');
    expect(await page.evaluate(() =>
      getComputedStyle(document.querySelector('.court[data-m="0"] .half[data-side="0"]')).backgroundColor
    )).toBe('rgba(0, 0, 0, 0)');

    const S0 = await state(page);
    const rightTeam = S0.rounds[0].m[0].b.map(i => S0.players[i]);
    await right.click();
    await expect(page.locator('.padl')).toContainText(`${rightTeam[0]} & ${rightTeam[1]}`);
    await page.click('[data-act=pick][data-v="15"]');
    const m = (await state(page)).rounds[0].m[0];
    expect([m.sa, m.sb]).toEqual([6, 15]);
    await expect(right).toBeFocused();
  });

  test('score pad aligns complementary score pairs vertically (10/11, 9/12, ...)', async ({ page }) => {
    await start(page, { points: 21 });
    await page.locator('.court').first().locator('.half[data-side="0"]').click();
    const pos21 = await page.evaluate(() => Object.fromEntries(
      [...document.querySelectorAll('.pad [data-act=pick]')].map(b => {
        const r = b.getBoundingClientRect();
        return [b.dataset.v, { x: Math.round(r.left), y: Math.round(r.top) }];
      })
    ));
    // 10/11 in first column, 9/12 in second, ..., 0/21 in last
    for (let k = 0; k <= 10; k++) {
      const lo = 10 - k, hi = 11 + k;
      expect(pos21[lo].x).toBe(pos21[hi].x);
      expect(pos21[lo].y).toBeLessThan(pos21[hi].y);
      if (k > 0) expect(pos21[lo].x).toBeGreaterThan(pos21[lo + 1].x);
    }

    // Even total (24): 12 alone first, then 11/13, 10/14, ..., 0/24
    await page.evaluate(() => localStorage.clear());
    await start(page, { points: 24 });
    await page.locator('.court').first().locator('.half[data-side="0"]').click();
    const pos24 = await page.evaluate(() => Object.fromEntries(
      [...document.querySelectorAll('.pad [data-act=pick]')].map(b => {
        const r = b.getBoundingClientRect();
        return [b.dataset.v, { x: Math.round(r.left), y: Math.round(r.top) }];
      })
    ));
    expect(pos24[12].x).toBeLessThan(pos24[11].x);
    for (let k = 1; k <= 12; k++) {
      const lo = 12 - k, hi = 12 + k;
      expect(pos24[lo].x).toBe(pos24[hi].x);
      expect(pos24[lo].y).toBeLessThan(pos24[hi].y);
      if (k > 1) expect(pos24[lo].x).toBeGreaterThan(pos24[lo + 1].x);
    }
  });

  test('Enter on a focused number saves that number, not the previous score', async ({ page }) => {
    await start(page);
    await page.locator('.court').first().locator('.half[data-side="0"]').click();
    await page.click('[data-act=pick][data-v="15"]');
    await page.locator('.court').first().locator('.half[data-side="0"]').click();
    await page.focus('[data-act=pick][data-v="7"]');
    await page.keyboard.press('Enter');
    expect((await state(page)).rounds[0].m[0].sa).toBe(7);
  });

  test('Enter on a focused "Clear result" clears the score', async ({ page }) => {
    await start(page);
    await page.locator('.court').first().locator('.half[data-side="0"]').click();
    await page.click('[data-act=pick][data-v="15"]');
    await page.locator('.court').first().locator('.half[data-side="0"]').click();
    await page.focus('[data-act=clear]');
    await page.keyboard.press('Enter');
    expect((await state(page)).rounds[0].m[0].sa).toBeNull();
  });

  test('Enter on a focused Cancel does not save', async ({ page }) => {
    await start(page);
    await page.locator('.court').first().locator('.half[data-side="0"]').click();
    await page.keyboard.press('9');
    await page.focus('.dlg [data-act=close]');
    await page.keyboard.press('Enter');
    expect((await state(page)).rounds[0].m[0].sa).toBeNull();
  });

  test('number buttons cover 0 to the points total', async ({ page }) => {
    await start(page, { points: 32 });
    await page.locator('.court').first().locator('.half[data-side="0"]').click();
    await expect(page.locator('[data-act=pick]')).toHaveCount(33);
  });

  test('Tab keeps focus inside the dialog; Escape closes and refocuses the court', async ({ page }) => {
    await start(page);
    await page.locator('.court').nth(1).locator('.half[data-side="0"]').click();
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press(i % 7 ? 'Tab' : 'Shift+Tab');
      expect(await page.evaluate(() => !!document.activeElement.closest('#layer'))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(page.locator('#layer')).toBeEmpty();
    await expect(page.locator('.half[data-m="1"][data-side="0"]')).toBeFocused();
  });
});

test.describe('rounds and standings', () => {
  test('Americano: no repeated partners in the first 5 rounds', async ({ page }) => {
    await start(page, { names: NAMES18.slice(0, 16) });
    for (let r = 0; r < 4; r++) { await finishRound(page); await page.click('[data-act=next]'); }
    const S = await state(page);
    const seen = new Set();
    for (const r of S.rounds) for (const m of r.m) for (const t of [m.a, m.b]) {
      const k = [...t].sort((x, y) => x - y).join('-');
      expect(seen.has(k), `partners ${k} repeated`).toBe(false);
      seen.add(k);
    }
  });

  test('sit-outs rotate fairly', async ({ page }) => {
    await start(page); // 18 players, 4 courts → 2 sit out per round
    for (let r = 0; r < 8; r++) { await finishRound(page); await page.click('[data-act=next]'); }
    const S = await state(page);
    const byes = S.players.map(() => 0);
    S.rounds.forEach(r => { expect(r.bye).toHaveLength(2); r.bye.forEach(p => byes[p]++); });
    expect(Math.max(...byes) - Math.min(...byes)).toBeLessThanOrEqual(1);
  });

  test('sitting out earns half a game once the round is complete', async ({ page }) => {
    await start(page, { points: 21 });
    const S = await state(page);
    const sitter = S.players[S.rounds[0].bye[0]];
    for (let i = 0; i < 3; i++) {
      await page.locator('.court').nth(i).click();
      await page.click('[data-act=pick][data-v="10"]');
    }
    expect((await standingsPts(page))[sitter]).toBe(0);
    await page.locator('.court').nth(3).click();
    await page.click('[data-act=pick][data-v="10"]');
    expect((await standingsPts(page))[sitter]).toBe(10.5);
  });

  test('correcting an old result keeps that round\'s sit-out bonus', async ({ page }) => {
    await start(page, { points: 21 });
    for (let r = 0; r < 3; r++) { await finishRound(page); await page.click('[data-act=next]'); }
    await finishRound(page);
    const S = await state(page);
    const sitters = S.rounds[1].bye.map(i => S.players[i]);
    const m = S.rounds[1].m[0];
    const before = await standingsPts(page);
    await page.click('[data-act=menu]');
    await page.click('[data-act=history]');
    await page.click('.hm[data-r="1"][data-m="0"]');
    await page.click('[data-act=clear]');
    const after = await standingsPts(page);
    for (const s of sitters) expect(after[s], s).toBe(before[s]);
    for (const i of m.a) expect(after[S.players[i]]).toBe(before[S.players[i]] - m.sa);
    for (const i of m.b) expect(after[S.players[i]]).toBe(before[S.players[i]] - m.sb);
  });

  test('next round is blocked while any earlier round misses a result', async ({ page }) => {
    await start(page);
    await finishRound(page); await page.click('[data-act=next]');
    await finishRound(page);
    const next = page.locator('[data-act=next]');
    await expect(next).toBeEnabled();
    await page.click('[data-act=menu]');
    await page.click('[data-act=history]');
    await page.click('.hm[data-r="0"][data-m="0"]');
    await page.click('[data-act=clear]');
    await page.keyboard.press('Escape');
    await expect(next).toBeDisabled();
    await expect(next).toHaveAttribute('title', 'Round 1 is missing a result');
    await expect(page.locator('.prog')).toContainText('round 1 incomplete');
    await page.evaluate(() => document.querySelector('[data-act=next]').click());
    expect((await state(page)).rounds).toHaveLength(2);
  });

  test('Mexicano pairs 1st & 4th vs 2nd & 3rd from the standings', async ({ page }) => {
    await start(page, { mode: 'mexicano', names: NAMES18.slice(0, 8), courts: 2, points: 24 });
    await finishRound(page, i => [20, 3][i]);
    await page.click('[data-act=next]');
    const order = await page.evaluate(() => [...document.querySelectorAll('.rr .pn')].map(e => e.textContent));
    const S = await state(page);
    const pairs = S.rounds[1].m.map(m => [m.a.map(i => S.players[i]), m.b.map(i => S.players[i])]);
    // standings shown on the board for round 2 are still the ones after round 1
    expect(pairs[0]).toEqual([[order[0], order[3]], [order[1], order[2]]]);
    expect(pairs[1]).toEqual([[order[4], order[7]], [order[5], order[6]]]);
  });

  test('ranks are shared on ties', async ({ page }) => {
    await start(page, { names: NAMES18.slice(0, 8), courts: 2 });
    await finishRound(page, 12);
    const ranks = await page.evaluate(() => [...document.querySelectorAll('.rr .pos b')].map(e => e.textContent));
    expect(new Set(ranks)).toEqual(new Set(['1']));
  });

  test('removing a round goes back to the previous one', async ({ page }) => {
    await start(page);
    await finishRound(page); await page.click('[data-act=next]');
    await page.click('[data-act=menu]');
    await page.click('[data-act=undo]');
    await expect(page.locator('.rnd')).toHaveText('Round 1');
    expect((await state(page)).rounds).toHaveLength(1);
  });
});

test.describe('round history', () => {
  test('stays open after correcting a score; Escape from a score goes back to it', async ({ page }) => {
    await start(page);
    await finishRound(page); await page.click('[data-act=next]');
    await page.click('[data-act=menu]');
    await page.click('[data-act=history]');
    await page.click('.hm[data-r="0"][data-m="1"]');
    await page.click('[data-act=pick][data-v="3"]');
    await expect(page.locator('#ht')).toBeVisible();
    await expect(page.locator('.hm[data-r="0"][data-m="1"] .s')).toHaveText('3–21');
    await page.click('.hm[data-r="0"][data-m="1"]');
    await page.keyboard.press('Escape');
    await expect(page.locator('#ht')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#layer')).toBeEmpty();
    await expect(page.locator('[data-act=menu]')).toBeFocused();
  });
});

test.describe('two tabs', () => {
  test('results entered in another tab are not overwritten', async ({ page, context }) => {
    await start(page);
    const other = await context.newPage();
    await other.goto(URL);
    await other.locator('.court').nth(1).locator('.half[data-side="0"]').click();
    await other.click('[data-act=pick][data-v="20"]');
    await expect(page.locator('.court[data-m="1"] .scr').first()).toHaveText('20');
    await page.locator('.court').first().locator('.half[data-side="0"]').click();
    await page.click('[data-act=pick][data-v="5"]');
    const sas = (await state(page)).rounds[0].m.map(m => m.sa);
    expect(sas.slice(0, 2)).toEqual([5, 20]);
  });
});

test.describe('layout', () => {
  test('short names are not truncated in the standings at 1024px', async ({ page }) => {
    await start(page, { names: [...NAMES18.slice(0, 17), 'Maximiliano Alexandre Fernandes-Rodrigues'] });
    const cut = await page.evaluate(() => [...document.querySelectorAll('.rr .pn')]
      .filter(e => e.textContent.length <= 6 && e.scrollWidth > e.clientWidth).map(e => e.textContent));
    expect(cut).toEqual([]);
  });

  test('standings header columns align with row columns on board and final view', async ({ page }) => {
    await start(page);
    const checkAlign = () => page.evaluate(() => {
      const h = [...document.querySelectorAll('.rh > *')].map(e => e.getBoundingClientRect());
      const r = [...document.querySelector('.rr').children].map(e => e.getBoundingClientRect());
      return h.map((hb, i) => ({
        dl: Math.abs(hb.left - r[i].left),
        dr: Math.abs(hb.right - r[i].right),
      }));
    });
    for (const d of await checkAlign()) {
      expect(d.dl).toBeLessThanOrEqual(1);
      expect(d.dr).toBeLessThanOrEqual(1);
    }
    await finishRound(page);
    await page.click('[data-act=menu]');
    await page.click('[data-act=end]');
    await page.click('[data-act=ok]');
    for (const d of await checkAlign()) {
      expect(d.dl).toBeLessThanOrEqual(1);
      expect(d.dr).toBeLessThanOrEqual(1);
    }
  });

  test('no horizontal overflow on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await start(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('.court').first().click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test('no script errors during a full session', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await start(page, { mode: 'mexicano' });
    for (let r = 0; r < 3; r++) { await finishRound(page, 7); await page.click('[data-act=next]'); }
    await page.click('[data-act=menu]');
    await page.click('[data-act=new]');
    await page.click('button[type=submit]');
    await page.click('[data-act=ok]');
    expect(errors).toEqual([]);
  });
});

test.describe('URL fragment sharing', () => {
  test('persists state in the URL fragment without polluting browser history', async ({ page }) => {
    await start(page);
    const histLen = await page.evaluate(() => history.length);
    const h1 = await page.evaluate(() => location.hash);
    expect(h1).toMatch(/^#[12][A-Za-z0-9_-]+$/);

    await page.locator('.court').first().click();
    await page.click('[data-act=pick][data-v="15"]');
    const h2 = await page.evaluate(() => location.hash);
    expect(h2).toMatch(/^#[12][A-Za-z0-9_-]+$/);
    expect(h2).not.toBe(h1);

    await finishRound(page);
    await page.click('[data-act=next]');
    const h3 = await page.evaluate(() => location.hash);
    expect(h3).not.toBe(h2);
    expect(await page.evaluate(() => history.length)).toBe(histLen);
  });

  test('opening a shared URL in a fresh browser restores the full tournament', async ({ page, browser }) => {
    const names = ['João Moreno', 'Smith, John', '<b>Ana</b>', 'Bruno', 'Carla', 'Diego', 'Elena', 'Felix', 'Gina', 'Hugo'];
    await start(page, { name: 'Sexta 🎾', mode: 'mexicano', points: 21, courts: 2, names });
    await finishRound(page, i => [15, 7][i]);
    await page.click('[data-act=next]');
    await page.locator('.court').first().click();
    await page.click('[data-act=pick][data-v="11"]');

    const orig = await state(page);
    const origPts = await standingsPts(page);
    const sharedUrl = page.url();

    const freshCtx = await browser.newContext();
    await freshCtx.route('**/*', r => r.request().url().startsWith(URL)
      ? r.fulfill({ status: 200, contentType: 'text/html', body: HTML })
      : r.abort());
    const p2 = await freshCtx.newPage();
    await p2.goto(sharedUrl);
    await expect(p2.locator('.rnd')).toHaveText('Round 2');
    await expect(p2.locator('.top .ttl')).toHaveText('Sexta 🎾');
    expect(await standingsPts(p2)).toEqual(origPts);

    const restored = await state(p2);
    expect(restored.name).toBe(orig.name);
    expect(restored.mode).toBe(orig.mode);
    expect(restored.total).toBe(orig.total);
    expect(restored.courts).toBe(orig.courts);
    expect(restored.players).toEqual(orig.players);
    expect(restored.rounds.length).toBe(orig.rounds.length);
    for (let i = 0; i < orig.rounds.length; i++) {
      expect(restored.rounds[i].m).toEqual(orig.rounds[i].m);
      expect([...restored.rounds[i].bye].sort((a, b) => a - b)).toEqual([...orig.rounds[i].bye].sort((a, b) => a - b));
    }
    await freshCtx.close();
  });

  test('shared URL takes precedence over existing localStorage and draft', async ({ page, browser }) => {
    await start(page, { name: 'First' });
    const urlA = page.url();

    const ctx2 = await browser.newContext();
    await ctx2.route('**/*', r => r.request().url().startsWith(URL)
      ? r.fulfill({ status: 200, contentType: 'text/html', body: HTML })
      : r.abort());
    const other = await ctx2.newPage();
    await start(other, { name: 'Second', names: NAMES18.slice(0, 8), courts: 2 });
    await other.click('[data-act=menu]');
    await other.click('[data-act=new]');
    await other.fill('#tn', 'Unsaved draft');

    await other.goto(urlA);
    await expect(other.locator('.top .ttl')).toHaveText('First');
    await expect(other.locator('.rnd')).toHaveText('Round 1');
    await ctx2.close();
  });

  test('corrupt or unknown URL hashes fall back cleanly without errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    for (const bad of ['#garbage', '#1!!!', '#1AAAA', '#2AAAA', '#2eJw']) {
      await page.goto(URL + bad);
      await expect(page.locator('#sf')).toBeVisible();
    }
    expect(errors).toEqual([]);
  });

  test('hashchange switches to the tournament in the new fragment', async ({ page }) => {
    await start(page, { name: 'Tourney A', names: NAMES18.slice(0, 8), courts: 2 });
    const hashA = await page.evaluate(() => location.hash);

    await page.click('[data-act=menu]');
    await page.click('[data-act=new]');
    await page.fill('#tn', 'Tourney B');
    await page.click('button[type=submit]');
    await page.click('[data-act=ok]');
    await expect(page.locator('.top .ttl')).toHaveText('Tourney B');

    await page.evaluate(h => { location.hash = h; }, hashA);
    await expect(page.locator('.top .ttl')).toHaveText('Tourney A');
  });

  test('compresses large tournaments tightly and uses deflate for longer name lists', async ({ page }) => {
    const fullNames = [
      'João Moreno', 'Ana Silva', 'Bruno Santos', 'Carla Oliveira',
      'Diego Costa', 'Elena Pereira', 'Felix Rodrigues', 'Gina Martins',
      'Hugo Ferreira', 'Iris Almeida', 'Jonas Ribeiro', 'Katja Sousa',
      'Luca Carvalho', 'Mara Teixeira', 'Nico Mendes', 'Olga Fernandes',
    ];
    await start(page, { name: 'Friday Club Americano', names: fullNames, courts: 4 });
    for (let r = 0; r < 5; r++) { await finishRound(page, 13); await page.click('[data-act=next]'); }

    await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#2[A-Za-z0-9_-]+$/);
    const hash = await page.evaluate(() => location.hash);
    const jsonLen = await page.evaluate(() => localStorage.getItem('padel-tourney-v1').length);
    expect(hash.length).toBeLessThan(350);
    expect(hash.length).toBeLessThan(jsonLen / 4);
  });

  test('Copy share link copies the current URL', async ({ page }) => {
    await start(page, { name: 'Share me' });
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: t => { window.__copied = t; return Promise.resolve(); } },
      });
    });
    await page.click('[data-act=menu]');
    await page.click('[data-act=share]');
    await expect(page.locator('[data-act=share]')).toHaveText('Link copied');
    const copied = await page.evaluate(() => window.__copied);
    expect(copied).toBe(page.url());
    expect(copied).toMatch(/#[12][A-Za-z0-9_-]+$/);
  });

  test('ending a tournament shows only final standings and shrinks the URL', async ({ page, browser }) => {
    await start(page, { name: 'Club Night', mode: 'mexicano', points: 21, courts: 4, names: NAMES18.slice(0, 16) });
    for (let r = 0; r < 4; r++) { await finishRound(page, i => [15, 13, 11, 18][i]); await page.click('[data-act=next]'); }
    // On round 5 with 0 results entered, capture active URL and standings
    const activeHash = await page.evaluate(() => location.hash);
    const expectedPts = await standingsPts(page);

    await page.click('[data-act=menu]');
    await page.click('[data-act=end]');
    await page.click('[data-act=ok]');

    await expect(page.locator('.rnd')).toHaveText('Final');
    await expect(page.locator('.court')).toHaveCount(0);
    await expect(page.locator('.rank h2 small')).toHaveText('After 4 rounds');
    await expect(page).toHaveTitle('Club Night · Final');

    await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#[34][A-Za-z0-9_-]+$/);
    const finalHash = await page.evaluate(() => location.hash);
    expect(finalHash.length).toBeLessThan(activeHash.length);

    // Open in a fresh browser: should render only the final standings table with identical scores
    const freshCtx = await browser.newContext();
    await freshCtx.route('**/*', r => r.request().url().startsWith(URL)
      ? r.fulfill({ status: 200, contentType: 'text/html', body: HTML })
      : r.abort());
    const p2 = await freshCtx.newPage();
    await p2.goto(URL + finalHash);
    await expect(p2.locator('.rnd')).toHaveText('Final');
    await expect(p2.locator('.court')).toHaveCount(0);
    await expect(p2.locator('.rank h2 small')).toHaveText('After 4 rounds');
    expect(await standingsPts(p2)).toEqual(expectedPts);
    await freshCtx.close();
  });

  test('ending a tournament with sit-outs preserves half points and diffs across share URL', async ({ page, browser }) => {
    await start(page, { name: 'Sitout Cup', points: 21, courts: 4, names: NAMES18 });
    await finishRound(page, 14);
    await page.click('[data-act=next]');
    await finishRound(page, 8);
    const expectedRows = await page.evaluate(() => [...document.querySelectorAll('.rr')].map(r => ({
      rank: r.querySelector('.pos b').textContent,
      nm: r.querySelector('.pn').textContent,
      w: r.querySelectorAll('.cn')[0].textContent,
      diff: r.querySelectorAll('.cn')[1].textContent,
      pts: r.querySelectorAll('.cn')[2].textContent,
    })));

    await page.click('[data-act=menu]');
    await page.click('[data-act=end]');
    await page.click('[data-act=ok]');
    await expect(page.locator('.rnd')).toHaveText('Final');
    const finalUrl = page.url();

    const freshCtx = await browser.newContext();
    await freshCtx.route('**/*', r => r.request().url().startsWith(URL)
      ? r.fulfill({ status: 200, contentType: 'text/html', body: HTML })
      : r.abort());
    const p2 = await freshCtx.newPage();
    await p2.goto(finalUrl);
    await expect(p2.locator('.rnd')).toHaveText('Final');
    const restoredRows = await p2.evaluate(() => [...document.querySelectorAll('.rr')].map(r => ({
      rank: r.querySelector('.pos b').textContent,
      nm: r.querySelector('.pn').textContent,
      w: r.querySelectorAll('.cn')[0].textContent,
      diff: r.querySelectorAll('.cn')[1].textContent,
      pts: r.querySelectorAll('.cn')[2].textContent,
    })));
    expect(restoredRows).toEqual(expectedRows);
    await freshCtx.close();
  });
});
