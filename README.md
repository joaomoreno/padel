# Padel tournament

A single-page Americano / Mexicano tournament app: everything lives in `index.html`, and state is kept in the URL fragment for sharing. Live at https://padel.joaomoreno.com/.

## Tests

Browser tests in `tests/` drive `index.html` with [Playwright](https://playwright.dev):

```sh
npm install
npx playwright install chromium   # or set CHROME_PATH=/path/to/chrome to use an installed Chrome
npm test
```

CI runs them on every push and pull request; GitHub Pages only deploys from `main` after they pass, and only publishes `index.html` and `LICENSE`.
