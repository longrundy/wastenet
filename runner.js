/**
 * WasteNet Headless Scanner Runner
 * ================================
 * Runs the existing WasteNet Box Monitor scan engine (the same v4.5.1
 * code that runs under Tampermonkey) inside headless Chromium on a
 * server, on a schedule, with no human and no desktop browser.
 *
 * WHAT IT DOES, START TO FINISH:
 *   1. Launches headless Chromium (Playwright).
 *   2. Injects the scan engine (engine.user.js, an exact copy of the
 *      Tampermonkey script) so it loads on EVERY page navigation -
 *      exactly replicating how Tampermonkey re-injects after each of
 *      the scan's mid-run page reloads. The engine's own
 *      localStorage state machine handles resume, untouched.
 *   3. Navigates to Monitor.aspx; when the portal bounces to
 *      login.aspx, fills the saved credentials (from .env) and logs
 *      in - same structural field detection as the userscript.
 *   4. Starts a full scan via the engine's exposed
 *      window.__startBoxServiceCheck() hook.
 *   5. Watches the engine's saved state until done (or a hard 4-hour
 *      timeout), tolerating the many page reloads along the way.
 *   6. Gives the upload 2 minutes to land, then (optionally, when
 *      DASHBOARD_KEY is set in .env) verifies via the Apps Script's
 *      ?action=list_tabs that a tab for TODAY exists in the sheet.
 *   7. On ANY failure: saves a screenshot to ./logs, and (when
 *      SENDGRID_API_KEY is set in .env) emails the failure reason to
 *      ALERT_EMAIL. Silence + a fresh tab in the sheet = success.
 *
 * FILES THIS EXPECTS NEXT TO IT (/opt/wastenet):
 *   engine.user.js  - the scan engine (same file as the Tampermonkey
 *                     script; update it here whenever the userscript
 *                     is updated)
 *   .env            - secrets, never committed anywhere:
 *                       CES_USER=...
 *                       CES_PASS=...
 *                       SENDGRID_API_KEY=...   (optional, for alerts)
 *                       ALERT_EMAIL=...        (optional, for alerts)
 *                       DASHBOARD_KEY=...      (optional, for upload verification)
 *
 * RUN MODES:
 *   node runner.js           - full scan
 *   node runner.js --test 5  - 5-box test batch
 *   node runner.js --login-only  - just prove login works, then exit
 */

require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');

const PORTAL_HOME = 'http://h1.ces-web.com/Monitor.aspx';
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwc3siwl0OTP2O5WzNZCDn4cj3MDVRfcVxJW0TZtoPnAKLwhYSwmW_m1h7ib6Yf_Dvk9w/exec';
const STATE_KEY = 'box_service_check_v2_state'; // must match STORAGE_KEY in engine.user.js
const ENGINE_PATH = path.join(__dirname, 'engine.user.js');
const LOG_DIR = path.join(__dirname, 'logs');
const SCAN_TIMEOUT_MS = 4 * 60 * 60 * 1000; // hard ceiling on a run
const POLL_MS = 30000;

const argv = process.argv.slice(2);
const LOGIN_ONLY = argv.includes('--login-only');
const testIdx = argv.indexOf('--test');
const TEST_COUNT = testIdx !== -1 ? parseInt(argv[testIdx + 1], 10) || 5 : null;

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function ts() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
function log(msg) { console.log('[' + ts() + '] ' + msg); }

function todayTabPrefix() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** Failure alert via SendGrid (optional - silently skipped without a key). */
function sendAlert(subject, body) {
  return new Promise((resolve) => {
    const key = process.env.SENDGRID_API_KEY;
    const to = process.env.ALERT_EMAIL;
    if (!key || !to) { log('No SENDGRID_API_KEY/ALERT_EMAIL configured - skipping email alert.'); return resolve(false); }
    const payload = JSON.stringify({
      personalizations: [{ to: [{ email: to }], subject: subject }],
      from: { email: 'office@wastenetinc.com', name: 'WasteNet Scanner' },
      content: [{ type: 'text/plain', value: body }],
    });
    const req = https.request({
      hostname: 'api.sendgrid.com', path: '/v3/mail/send', method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => { log('Alert email HTTP ' + res.statusCode); res.resume(); resolve(res.statusCode === 202); });
    req.on('error', (e) => { log('Alert email failed: ' + e.message); resolve(false); });
    req.write(payload); req.end();
  });
}

/** Optional upload verification via the Apps Script list_tabs action. */
function verifyTodayTabExists() {
  return new Promise((resolve) => {
    const key = process.env.DASHBOARD_KEY;
    const url = APPS_SCRIPT_URL + '?action=list_tabs' + (key ? '&key=' + encodeURIComponent(key) : '');
    const get = (u, hops) => {
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) {
          res.resume(); return get(res.headers.location, hops + 1); // Apps Script always redirects once
        }
        let body = '';
        res.on('data', (c) => body += c);
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            if (j.authRequired) { log('list_tabs requires DASHBOARD_KEY (not set/wrong) - skipping verification.'); return resolve(null); }
            if (!j.ok || !Array.isArray(j.tabs)) return resolve(null);
            resolve(j.tabs.some((t) => String(t).startsWith(todayTabPrefix())));
          } catch (e) { resolve(null); }
        });
      }).on('error', () => resolve(null));
    };
    get(url, 0);
  });
}

async function screenshot(page, name) {
  try {
    const f = path.join(LOG_DIR, name + '_' + Date.now() + '.png');
    await page.screenshot({ path: f, fullPage: true });
    log('Screenshot saved: ' + f);
  } catch (e) { /* page may be mid-navigation - fine */ }
}

/** Structural login, now matching the userscript's isLoginPage() rule
 *  EXACTLY: it is only a login form when a password field is present
 *  AND the box grid is ABSENT. (Confirmed live: the real Monitor page
 *  contains a stray password-type input somewhere, so password-field
 *  presence alone false-positived on a logged-in Monitor page and the
 *  runner tried to type the username into the disabled Date Pull
 *  Requested box.) Filling is done directly in the DOM - same as the
 *  userscript - so disabled stray fields can never block it. */
async function loginIfNeeded(page) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1500); // let any client-side redirect settle
  const status = await page.evaluate(() => {
    const gridPresent = [...document.querySelectorAll('input[type="button"]')]
      .some((b) => /Select\$/.test(b.getAttribute('onclick') || ''));
    const pwdPresent = !!document.querySelector('input[type="password"]');
    return { gridPresent, pwdPresent };
  });
  if (status.gridPresent || !status.pwdPresent) return false; // logged in / not a login form
  const user = process.env.CES_USER, pass = process.env.CES_PASS;
  if (!user || !pass) throw new Error('CES_USER / CES_PASS not set in .env');
  log('Login form detected (at ' + page.url() + ') - logging in as ' + user + '...');
  await page.evaluate(({ u, p }) => {
    const pwd = document.querySelector('input[type="password"]');
    const texts = [...document.querySelectorAll('input[type="text"]')];
    let userInput = null;
    for (const t of texts) {
      if (t.compareDocumentPosition(pwd) & Node.DOCUMENT_POSITION_FOLLOWING) userInput = t;
    }
    if (!userInput) throw new Error('Could not locate the User Name field.');
    userInput.value = u;
    pwd.value = p;
    const cb = document.querySelector('input[type="checkbox"]');
    if (cb && !cb.checked) cb.click();
    const btn = [...document.querySelectorAll('input[type="submit"], input[type="button"], button')]
      .find((b) => /log\s*in/i.test(b.value || b.textContent || ''));
    if (!btn) throw new Error('Could not locate the Log In button.');
    btn.click();
  }, { u: user, p: pass });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2500);
  const after = await page.evaluate(() => {
    const gridPresent = [...document.querySelectorAll('input[type="button"]')]
      .some((b) => /Select\$/.test(b.getAttribute('onclick') || ''));
    const pwdPresent = !!document.querySelector('input[type="password"]');
    return { gridPresent, pwdPresent };
  });
  if (!after.gridPresent && after.pwdPresent) {
    throw new Error('Login was rejected - still on the login form after submitting. Check CES_USER/CES_PASS in .env.');
  }
  log('Logged in - now at ' + page.url());
  return true;
}

async function main() {
  log('=== WasteNet headless scan run starting (' + (LOGIN_ONLY ? 'LOGIN TEST' : TEST_COUNT ? 'TEST ' + TEST_COUNT + ' BOXES' : 'FULL SCAN') + ') ===');
  const engineSource = fs.readFileSync(ENGINE_PATH, 'utf8');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  // Re-inject the engine on EVERY document - this is the Tampermonkey
  // replacement. CRITICAL DIFFERENCE FOUND LIVE: addInitScript runs at
  // document-START (before <body> exists), while Tampermonkey runs the
  // script at document-idle. Un-wrapped, the engine survives the first
  // page (its own graph-wait retry loop happens to delay it) but DIES
  // on every mid-scan reload - it goes straight to building its panel
  // against a null body. This wrapper defers the engine to
  // DOMContentLoaded, replicating Tampermonkey's timing exactly.
  // (Built with string concatenation, NOT a template literal - the
  // engine source itself contains backticks.)
  const wrapped = '(function(){var runEngine=function(){\n' + engineSource +
    '\n};if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",runEngine);}else{runEngine();}})();';
  await context.addInitScript(wrapped);
  const page = await context.newPage();
  page.on('console', (m) => {
    const t = m.text();
    // Surface the engine's own progress lines into our log.
    if (/Box \d|Scan|scan|AUTO-RUN|YES|Upload|upload|Green List|Days & Cycles/.test(t)) log('  [page] ' + t.slice(0, 200));
  });

  try {
    await page.goto(PORTAL_HOME, { timeout: 45000 });
    await loginIfNeeded(page);
    if (!/Monitor\.aspx/i.test(page.url())) {
      log('Not on Monitor.aspx after login (at ' + page.url() + ') - navigating there.');
      await page.goto(PORTAL_HOME, { timeout: 45000 });
      await loginIfNeeded(page); // in case the session didn't stick
    }

    // Grid present = genuinely logged in and on the right page.
    await page.waitForFunction(() =>
      [...document.querySelectorAll('input[type="button"]')].some((b) => /Select\$/.test(b.getAttribute('onclick') || '')),
      { timeout: 30000 });
    log('Monitor page verified - box grid present.');

    if (LOGIN_ONLY) {
      log('LOGIN TEST PASSED. Exiting.');
      await browser.close();
      return;
    }

    // Clear any stale scan state from a previous crashed run, then start.
    await page.evaluate((k) => localStorage.removeItem(k), STATE_KEY);
    await page.waitForFunction(() => typeof window.__startBoxServiceCheck === 'function', { timeout: 30000 });
    await page.evaluate((n) => window.__startBoxServiceCheck(n || undefined), TEST_COUNT);
    log('Scan started.');

    // Watch until done. The page reloads constantly mid-scan - every
    // poll must tolerate being mid-navigation.
    const startedAt = Date.now();
    let lastProgress = '';
    for (;;) {
      if (Date.now() - startedAt > SCAN_TIMEOUT_MS) throw new Error('Scan exceeded the 4-hour ceiling.');
      await new Promise((r) => setTimeout(r, POLL_MS));
      let state = null;
      try {
        const raw = await page.evaluate((k) => localStorage.getItem(k), STATE_KEY);
        state = raw ? JSON.parse(raw) : null;
      } catch (e) { continue; } // mid-reload - try again next poll
      if (!state) continue; // not readable yet
      const prog = (state.results ? state.results.length : 0) + '/' + (state.boxList ? state.boxList.length : '?');
      if (prog !== lastProgress) { log('Progress: ' + prog + ' boxes.'); lastProgress = prog; }
      if (state.done) {
        log('Engine reports DONE - ' + (state.results ? state.results.length : 0) + ' results. Allowing 2 minutes for upload...');
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 120000));

    const verified = await verifyTodayTabExists();
    if (verified === true) log("VERIFIED: today's tab exists in the Google Sheet.");
    else if (verified === false) throw new Error("Scan finished but NO tab for today was found in the sheet - upload may have failed.");
    else log('Upload verification skipped/unavailable - check the sheet manually.');

    log('=== RUN COMPLETE ===');
    await browser.close();
  } catch (err) {
    log('RUN FAILED: ' + err.message);
    await screenshot(page, 'failure');
    await sendAlert('WasteNet scanner FAILED - ' + todayTabPrefix(),
      'The headless scan run failed at ' + ts() + '.\n\nReason: ' + err.message +
      '\n\nA screenshot was saved in /opt/wastenet/logs on the server.' +
      '\n\nFallback: open Monitor.aspx in Chrome and click Run Service Check manually (the Tampermonkey scanner is still installed).');
    await browser.close();
    process.exit(1);
  }
}

main();
