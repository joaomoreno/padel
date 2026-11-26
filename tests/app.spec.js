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
    await page.locator('.court').nth(i).click();
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
    await page.locator('.court').first().click();
    await page.keyboard.press('1');
    await page.keyboard.press('5');
    await page.keyboard.press('Enter');
    const m = (await state(page)).rounds[0].m[0];
    expect([m.sa, m.sb]).toEqual([15, 6]);
    await expect(page.locator('.court[data-m="0"]')).toBeFocused();
  });

  test('Enter on a focused number saves that number, not the previous score', async ({ page }) => {
    await start(page);
    await page.locator('.court').first().click();
    await page.click('[data-act=pick][data-v="15"]');
    await page.locator('.court').first().click();
    await page.focus('[data-act=pick][data-v="7"]');
    await page.keyboard.press('Enter');
    expect((await state(page)).rounds[0].m[0].sa).toBe(7);
  });

  test('Enter on a focused "Clear result" clears the score', async ({ page }) => {
    await start(page);
    await page.locator('.court').first().click();
    await page.click('[data-act=pick][data-v="15"]');
    await page.locator('.court').first().click();
    await page.focus('[data-act=clear]');
    await page.keyboard.press('Enter');
    expect((await state(page)).rounds[0].m[0].sa).toBeNull();
  });

  test('Enter on a focused Cancel does not save', async ({ page }) => {
    await start(page);
    await page.locator('.court').first().click();
    await page.keyboard.press('9');
    await page.focus('.dlg [data-act=close]');
    await page.keyboard.press('Enter');
    expect((await state(page)).rounds[0].m[0].sa).toBeNull();
  });

  test('number buttons cover 0 to the points total', async ({ page }) => {
    await start(page, { points: 32 });
    await page.locator('.court').first().click();
    await expect(page.locator('[data-act=pick]')).toHaveCount(33);
  });

  test('Tab keeps focus inside the dialog; Escape closes and refocuses the court', async ({ page }) => {
    await start(page);
    await page.locator('.court').nth(1).click();
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press(i % 7 ? 'Tab' : 'Shift+Tab');
      expect(await page.evaluate(() => !!document.activeElement.closest('#layer'))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(page.locator('#layer')).toBeEmpty();
    await expect(page.locator('.court[data-m="1"]')).toBeFocused();
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
    await other.locator('.court').nth(1).click();
    await other.click('[data-act=pick][data-v="20"]');
    await expect(page.locator('.court[data-m="1"] .scr').first()).toHaveText('20');
    await page.locator('.court').first().click();
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
