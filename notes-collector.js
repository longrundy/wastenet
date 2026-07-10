/**
 * WasteNet Box Management Collector
 * =================================
 * v2.0 - DAILY SYNC PHASE
 *   v2.0 (2026-07-10): now POSTS results to the Apps Script backend
 *     ({ type: "box_management" } payload -> handleBoxManagementPost),
 *     which writes the five collector columns on Master Box List,
 *     converts HaulerAccount -> NBD/1-BD/2-BD via the Hauler Rule Map
 *     tab, and appends day-over-day changes to the CES Change Log tab.
 *     The collector itself still reports CES FACTS ONLY - all
 *     interpretation (the rule mapping) lives server-side on the
 *     editable map tab, per the standing architecture rule. Posting
 *     happens on FULL runs automatically; --test/--box runs stay
 *     local-only unless --post is added (for validating the pipeline
 *     on a handful of boxes before trusting the cron run). Requires
 *     APPS_SCRIPT_URL in .env - same web app URL the scanner/dashboard
 *     already use. Alerts (full runs only): post failure, UNMAPPED
 *     HaulerAccount values, boxes not found on Master Box List.
 *   v1.1 (2026-07-10): splitNotes rebuilt from live-data review of the
 *     93 no-divider boxes - a divider is now a 10+ underscore run
 *     ANYWHERE in a line (handles "____X", "____=", glued-to-content,
 *     and annotations after the divider); boxes with NO divider now
 *     put ALL notes in below-line so the dashboard never hides them.
 *     normalizeHauler now strips Dave's * < > decorations so
 *     "** +1 **" / "* +1 *" / "<+1" all group as "+1".
 *   v1.0 (2026-07-10): first version, login + full scrape verified
 *     live (479 boxes, 7 min).
 *
 * Runs SEPARATELY from the daily Monitor.aspx scan engine. This script
 * never touches engine.user.js, runner.js, or their cron entry.
 *
 * WHAT IT DOES:
 *   1. Launches headless Chromium (Playwright), logs into the CES
 *      portal using the exact same structural login as runner.js
 *      (credentials from the same .env).
 *   2. Navigates to BoxManagement.aspx.
 *   3. Walks the "Select Box To View" list page by page (the < > pager),
 *      clicking Select on every box.
 *   4. After each Select postback, scrapes from the Box Details panel:
 *        - HaulerAccount  (raw, exactly as CES has it)
 *        - HaulerCode
 *        - Notes          (raw, plus an above-line / below-line split
 *                          on the underscore divider)
 *        - Description, Cell (for human-readable output)
 *   5. Writes everything to ./logs/box-management-YYYY-MM-DD.csv and
 *      .json, and prints an INVENTORY of distinct HaulerAccount
 *      spellings with counts - the input for seeding the mapping tab.
 *
 * WHAT IT STILL DOES **NOT** DO:
 *   - Convert HaulerAccount to NBD / 1-BD / 2-BD locally - the payload
 *     carries the RAW value; conversion happens in Apps Script against
 *     the editable Hauler Rule Map tab (interpretation belongs in that
 *     layer, per the standing architecture rule: this script reports
 *     CES facts only)
 *
 * FILES THIS EXPECTS NEXT TO IT (/opt/wastenet):
 *   .env   - same file the scanner already uses:
 *              CES_USER=...
 *              CES_PASS=...
 *              SENDGRID_API_KEY=...   (optional, failure alerts)
 *              ALERT_EMAIL=...        (optional, failure alerts)
 *              APPS_SCRIPT_URL=...    (v2.0 - the deployed web app URL,
 *                                      same one the scanner posts scan
 *                                      results to; required for the
 *                                      daily post, everything else
 *                                      still works without it)
 *
 * RUN MODES:
 *   node notes-collector.js                 - full run, every box, POSTS
 *   node notes-collector.js --test 5        - first 5 boxes, local only
 *   node notes-collector.js --test 5 --post - first 5 boxes AND post
 *                                             (pipeline validation)
 *   node notes-collector.js --box 9,15,18   - only those IDs, local only
 *   node notes-collector.js --box 9 --post  - those IDs AND post
 *   node notes-collector.js --login-only    - prove login works, exit
 *
 * Failure behavior mirrors runner.js: screenshot to ./logs and a
 * SendGrid alert (when configured). A --test or --box run never emails.
 */

require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');

const BOX_MGMT_URL = 'http://h1.ces-web.com/BoxManagement.aspx';
const LOG_DIR = path.join(__dirname, 'logs');
const RUN_TIMEOUT_MS = 60 * 60 * 1000; // hard ceiling: 1 hour for ~480 boxes
const SELECT_TIMEOUT_MS = 20000;       // per-box postback wait
const PAGE_SETTLE_MS = 400;            // small settle after each postback
const MAX_PAGES = 100;                 // pager safety stop

const argv = process.argv.slice(2);
const LOGIN_ONLY = argv.includes('--login-only');
const testIdx = argv.indexOf('--test');
const TEST_COUNT = testIdx !== -1 ? parseInt(argv[testIdx + 1], 10) || 5 : null;
const boxIdx = argv.indexOf('--box');
const BOX_IDS = boxIdx !== -1
  ? String(argv[boxIdx + 1] || '').split(',').map((s) => s.trim()).filter(Boolean)
  : null;
const TARGETED = !!(BOX_IDS && BOX_IDS.length);
// v2.0: full runs always post to Apps Script; --test/--box runs post
// only when --post is explicitly added (so casual diagnostics can never
// half-overwrite the Master Box List columns with a partial box set -
// see the safety note inside postResultsToAppsScript()).
const FORCE_POST = argv.includes('--post');
const SHOULD_POST = LOGIN_ONLY ? false : ((!TEST_COUNT && !TARGETED) || FORCE_POST);
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL || '';

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function ts() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
function log(msg) { console.log('[' + ts() + '] ' + msg); }
function todayStamp() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** Failure alert via SendGrid - identical pattern to runner.js. */
function sendAlert(subject, body) {
  return new Promise((resolve) => {
    const key = process.env.SENDGRID_API_KEY;
    const to = process.env.ALERT_EMAIL;
    if (!key || !to) { log('No SENDGRID_API_KEY/ALERT_EMAIL configured - skipping email alert.'); return resolve(false); }
    const payload = JSON.stringify({
      personalizations: [{ to: [{ email: to }], subject: subject }],
      from: { email: 'office@wastenetinc.com', name: 'WasteNet Collector' },
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

async function screenshot(page, name) {
  try {
    const f = path.join(LOG_DIR, name + '_' + Date.now() + '.png');
    await page.screenshot({ path: f, fullPage: true });
    log('Screenshot saved: ' + f);
  } catch (e) { /* page may be mid-navigation - fine */ }
}

/** Structural login - same rule as runner.js: it is only a login form
 *  when a password field is present AND the Select$ grid is absent.
 *  (BoxManagement's right-hand list uses the same WebForms Select
 *  buttons as Monitor's grid, so grid-presence works here too.) */
async function loginIfNeeded(page) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1500);
  const status = await page.evaluate(() => {
    const gridPresent = [...document.querySelectorAll('input[type="button"], input[type="submit"]')]
      .some((b) => /Select\$/.test(b.getAttribute('onclick') || '') || /Select/i.test(b.getAttribute('name') || ''));
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
    const pwdPresent = !!document.querySelector('input[type="password"]');
    return { pwdPresent };
  });
  if (after.pwdPresent) {
    throw new Error('Login was rejected - still on the login form after submitting. Check CES_USER/CES_PASS in .env.');
  }
  log('Logged in - now at ' + page.url());
  return true;
}

/* ------------------------------------------------------------------ *
 *  PAGE-SIDE HELPERS (run inside the browser via page.evaluate)
 * ------------------------------------------------------------------ */

/** Harvest the boxes visible on the CURRENT page of the Select Box To
 *  View list. Finds the grid by its header row (BoxId / Cell /
 *  Description) and returns [{ boxId, cell, description }] for each
 *  data row that has a Select button. Runs in the page. */
function pageHarvestList() {
  const tables = [...document.querySelectorAll('table')];
  for (const t of tables) {
    const headText = (t.rows[0] ? t.rows[0].innerText : '') || '';
    if (!(/BoxId/i.test(headText) && /Description/i.test(headText))) continue;
    const out = [];
    for (let i = 1; i < t.rows.length; i++) {
      const r = t.rows[i];
      const btn = r.querySelector('input[type="button"], input[type="submit"], a');
      if (!btn) continue;
      const cells = [...r.cells].map((c) => (c.innerText || '').trim());
      // cells: [Select][BoxId][Cell][Description]
      const boxId = (cells[1] || '').trim();
      if (!/^\d+$/.test(boxId)) continue;
      out.push({ boxId: boxId, cell: cells[2] || '', description: cells[3] || '' });
    }
    if (out.length) return out;
  }
  return [];
}

/** Click the Select button on the row whose BoxId equals target.
 *  Returns true if the click was dispatched. Runs in the page. */
function pageClickSelect(target) {
  const tables = [...document.querySelectorAll('table')];
  for (const t of tables) {
    const headText = (t.rows[0] ? t.rows[0].innerText : '') || '';
    if (!(/BoxId/i.test(headText) && /Description/i.test(headText))) continue;
    for (let i = 1; i < t.rows.length; i++) {
      const r = t.rows[i];
      const cells = [...r.cells].map((c) => (c.innerText || '').trim());
      if ((cells[1] || '').trim() !== target) continue;
      const btn = r.querySelector('input[type="button"], input[type="submit"], a');
      if (!btn) return false;
      btn.click();
      return true;
    }
  }
  return false;
}

/** Scrape the Box Details panel by label text. For each wanted label,
 *  finds the row whose first cell matches it exactly and returns the
 *  value cell's textarea/input value or plain text. Runs in the page. */
function pageScrapeDetails() {
  function valueOfRow(row) {
    const valCell = row.cells[1];
    if (!valCell) return '';
    const ta = valCell.querySelector('textarea');
    if (ta) return ta.value;
    const inp = valCell.querySelector('input[type="text"]');
    if (inp) return inp.value;
    return (valCell.innerText || '').trim();
  }
  const wanted = ['BoxId', 'Description', 'Cell', 'HaulerAccount', 'HaulerCode', 'Notes', 'CesNotes'];
  const out = {};
  const rows = [...document.querySelectorAll('table tr')];
  for (const row of rows) {
    if (!row.cells || row.cells.length < 2) continue;
    const label = (row.cells[0].innerText || '').trim();
    if (wanted.indexOf(label) === -1) continue;
    if (out[label] !== undefined) continue; // first match wins (Box Details is the first panel in the DOM)
    out[label] = valueOfRow(row);
  }
  return out;
}

/** Find and click the pager's ">" (next page) button for the list.
 *  Returns true if a next button was found and clicked. Runs in page. */
function pageClickNext() {
  const btns = [...document.querySelectorAll('input[type="button"], input[type="submit"], a')];
  const next = btns.find((b) => {
    const v = (b.value !== undefined ? b.value : b.textContent) || '';
    return v.trim() === '>';
  });
  if (!next || next.disabled) return false;
  next.click();
  return true;
}

/* ------------------------------------------------------------------ *
 *  NODE-SIDE HELPERS
 * ------------------------------------------------------------------ */

/** Split a Notes field on the FIRST divider: a run of 10+ underscores
 *  ANYWHERE in a line (verified against live data 2026-07-10: Dave's
 *  dividers often carry trailing junk like "____X" / "____=", carry
 *  real annotations after them, or sit glued to the end of a content
 *  line - a whole-line-only rule missed 93 boxes).
 *    - Text BEFORE the underscore run (incl. earlier lines) -> above.
 *    - Text AFTER it -> kept at the top of below (it's real content,
 *      e.g. "[3/23/26 THRU 3/28 // WILL BE CLOSED]"), except a lone
 *      trailing X/x/= right after the underscores (typing artifact).
 *    - Later underscore runs inside below are stripped; lines left
 *      empty by that are dropped.
 *    - NO divider at all (old-format boxes): everything -> below, so
 *      the dashboard shows the full notes rather than hiding them. */
function splitNotes(raw) {
  const text = String(raw == null ? '' : raw).replace(/\r\n/g, '\n');
  const DIV = /_{10,}/;
  const m = text.match(DIV);
  if (!m) {
    return { above: '', below: text.trim(), hasDivider: false };
  }
  const above = text.slice(0, m.index).trim();
  let below = text.slice(m.index + m[0].length);
  below = below.replace(/^[ \t]*[Xx=](?=\s|$)/, ''); // lone artifact right after the divider
  below = below.replace(/_{10,}[ \t]*[Xx=]?/g, '');  // later divider runs (with their artifacts)
  // Trim each line's trailing space and collapse runs of blank lines.
  below = below
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { above: above, below: below, hasDivider: true };
}

/** Normalize a raw HaulerAccount value for the inventory grouping:
 *  strip Dave's decorations (leading/trailing * < > runs), collapse
 *  whitespace, trim, uppercase. Collapses "** +1 **", "* +1 *" and
 *  "<+1" all to "+1", "*48*" to "48", "+2>" to "+2", etc. Internal
 *  characters are untouched, so "+1> PW" keeps its ">" and stays a
 *  distinct value with its own mapping row.
 *  (Grouping only - the CSV always keeps the true raw value.) */
function normalizeHauler(raw) {
  return String(raw == null ? '' : raw)
    .trim()
    .replace(/^[*<>\s]+/, '')
    .replace(/[*<>\s]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * POSTs a JSON payload to the Apps Script web app and returns the
 * parsed JSON response. Apps Script ALWAYS answers a web-app POST with
 * a 302 redirect to script.googleusercontent.com (the same structural
 * quirk that forced JSONP on the dashboard's read side) - browsers and
 * Tampermonkey follow it automatically, but Node's https module does
 * not, so this follows up to 5 redirects by hand, switching to GET for
 * the hop (which is what the redirect target expects - the response
 * body lives there).
 */
function postToAppsScript(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const step = (urlStr, method, data, hops) => {
      if (hops > 5) return reject(new Error('Too many redirects posting to Apps Script.'));
      let u;
      try { u = new URL(urlStr); } catch (e) { return reject(new Error('Bad Apps Script URL: ' + urlStr)); }
      const opts = {
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        method: method,
        headers: {},
        timeout: 120000,
      };
      if (data) {
        opts.headers['Content-Type'] = 'application/json';
        opts.headers['Content-Length'] = Buffer.byteLength(data);
      }
      const req = https.request(opts, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); // drain, then follow
          return step(res.headers.location, 'GET', null, hops + 1);
        }
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(b)); }
          catch (e) { reject(new Error('Apps Script returned non-JSON (HTTP ' + res.statusCode + '): ' + b.slice(0, 300))); }
        });
      });
      req.on('timeout', () => { req.destroy(new Error('Apps Script request timed out.')); });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    };
    step(APPS_SCRIPT_URL, 'POST', body, 0);
  });
}

/**
 * v2.0 - sends the scraped results to Apps Script as a
 * { type: "box_management" } payload and logs/alerts on the summary
 * that comes back. The payload deliberately carries ONLY what the
 * backend writes (boxId, raw HaulerAccount, HaulerCode, below-line
 * notes) - the full record incl. notesRaw/above/divider stays in the
 * daily CSV/JSON on the droplet, which remains the raw-archive layer.
 *
 * PARTIAL-RUN SAFETY: posting a --test/--box subset only touches the
 * rows for the boxes actually in the payload (the backend matches by
 * Box ID and never clears rows it wasn't sent), so a --post validation
 * run can't blank out the rest of the fleet - but its values for THOSE
 * boxes do land for real, which is exactly the point of --post.
 *
 * Alerting (FULL runs only - a --post validation run just logs):
 *   - post failure                      -> alert (data didn't land)
 *   - unmapped HaulerAccount value(s)   -> alert (rule map needs a row)
 *   - box IDs not on Master Box List    -> alert (list drift vs CES)
 */
async function postResultsToAppsScript(results, stamp) {
  if (!APPS_SCRIPT_URL) {
    log('POST SKIPPED: APPS_SCRIPT_URL is not set in .env - results were NOT sent to the Master Box List.');
    if (!TEST_COUNT && !TARGETED) {
      await sendAlert('WasteNet collector: results NOT posted - ' + stamp,
        'The Box Management collector scraped ' + results.length + ' boxes but could not post them: APPS_SCRIPT_URL is missing from /opt/wastenet/.env.\n\nAdd the deployed Apps Script web app URL (the same one the scanner posts to) and re-run:\n  cd /opt/wastenet && node notes-collector.js');
    }
    return;
  }

  const payload = {
    type: 'box_management',
    date: stamp,
    results: results.map((r) => ({
      boxId: r.boxId,
      haulerAccountRaw: r.haulerAccountRaw,
      haulerCode: r.haulerCode,
      notesBelow: r.notesBelow,
    })),
  };

  log('Posting ' + payload.results.length + ' boxes to Apps Script...');
  let resp;
  try {
    resp = await postToAppsScript(payload);
  } catch (e) {
    log('POST FAILED: ' + e.message);
    if (!TEST_COUNT && !TARGETED) {
      await sendAlert('WasteNet collector: post to Apps Script FAILED - ' + stamp,
        'The Box Management collector scraped ' + results.length + ' boxes, but posting them to the Apps Script backend failed:\n\n' + e.message +
        '\n\nThe day\'s raw data is safe in /opt/wastenet/logs (box-management-' + stamp + '.csv/.json). Re-run the post by re-running the collector.');
    }
    return;
  }

  if (!resp || resp.ok !== true) {
    const errMsg = resp && resp.error ? resp.error : JSON.stringify(resp);
    log('POST REJECTED by Apps Script: ' + errMsg);
    if (!TEST_COUNT && !TARGETED) {
      await sendAlert('WasteNet collector: Apps Script rejected the post - ' + stamp,
        'The backend returned an error for today\'s box_management post:\n\n' + errMsg +
        '\n\nThe day\'s raw data is safe in /opt/wastenet/logs. Re-run the post by re-running the collector.');
    }
    return;
  }

  log('POST OK - matched ' + resp.boxesMatched + ' boxes on Master Box List'
    + (resp.bootstrap ? ' (BOOTSTRAP run - columns created, no changes logged)' : '')
    + ' | hauler changes: ' + resp.haulerChanged
    + ' | notes changes: ' + resp.notesChanged
    + ' | change-log rows: ' + resp.changesLogged);

  const problems = [];
  if (resp.unmapped && resp.unmapped.length) {
    const lines = resp.unmapped.map((u) => '  - Box ' + u.boxId + ': "' + u.value + '"');
    log('UNMAPPED HaulerAccount value(s) (' + resp.unmapped.length + ') - the Scheduling Rule (auto) cell reads UNMAPPED for these until a row is added to the Hauler Rule Map tab:\n' + lines.join('\n'));
    problems.push('UNMAPPED HaulerAccount value(s) - add a row for each to the "Hauler Rule Map" tab (column A = the value shown, column B = NBD, 1-BD, or 2-BD):\n' + lines.join('\n'));
  }
  if (resp.unknownBoxes && resp.unknownBoxes.length) {
    log('Boxes in CES but NOT on Master Box List (' + resp.unknownBoxes.length + '): ' + resp.unknownBoxes.join(', '));
    problems.push('Box IDs found on BoxManagement.aspx that have NO row on the Master Box List tab (CES vs list drift - probably new or renumbered boxes):\n  ' + resp.unknownBoxes.join(', '));
  }
  if (problems.length && !TEST_COUNT && !TARGETED) {
    await sendAlert('WasteNet collector: ' + (resp.unmapped ? resp.unmapped.length : 0) + ' unmapped / ' + (resp.unknownBoxes ? resp.unknownBoxes.length : 0) + ' unknown - ' + stamp,
      'Today\'s Box Management sync completed and posted successfully, but flagged the following for review:\n\n' + problems.join('\n\n') +
      '\n\nNothing was silently defaulted - unmapped boxes show "UNMAPPED (<value>)" in the Scheduling Rule (auto) column until the map tab is updated. The next nightly run picks the fix up automatically.');
  }
}

/** Wait until the Box Details panel shows the target BoxId (postback
 *  landed) - tolerant of the full-page WebForms reload. */
async function waitForBoxDetails(page, targetId) {
  await page.waitForFunction((tid) => {
    const rows = [...document.querySelectorAll('table tr')];
    for (const row of rows) {
      if (!row.cells || row.cells.length < 2) continue;
      if ((row.cells[0].innerText || '').trim() === 'BoxId') {
        return (row.cells[1].innerText || '').trim() === tid;
      }
    }
    return false;
  }, targetId, { timeout: SELECT_TIMEOUT_MS });
}

async function main() {
  log('=== WasteNet Box Management collector starting ('
    + (LOGIN_ONLY ? 'LOGIN TEST' : TARGETED ? 'TARGETED: box(es) ' + BOX_IDS.join(', ') : TEST_COUNT ? 'TEST ' + TEST_COUNT + ' BOXES' : 'FULL RUN')
    + ') ===');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  const startedAt = Date.now();

  const results = [];       // one entry per box scraped
  const seenBoxIds = new Set();
  let failures = [];        // boxes we attempted but could not scrape

  try {
    await page.goto(BOX_MGMT_URL, { timeout: 45000 });
    await loginIfNeeded(page);
    if (!/BoxManagement\.aspx/i.test(page.url())) {
      log('Not on BoxManagement.aspx after login (at ' + page.url() + ') - navigating there.');
      await page.goto(BOX_MGMT_URL, { timeout: 45000 });
      await loginIfNeeded(page);
    }

    // The right-hand list present = logged in and on the right page.
    await page.waitForFunction(() => {
      const tables = [...document.querySelectorAll('table')];
      return tables.some((t) => {
        const headText = (t.rows[0] ? t.rows[0].innerText : '') || '';
        return /BoxId/i.test(headText) && /Description/i.test(headText);
      });
    }, { timeout: 30000 });
    log('BoxManagement page verified - box list present.');

    if (LOGIN_ONLY) {
      log('LOGIN TEST PASSED. Exiting.');
      await browser.close();
      return;
    }

    let done = false;
    let pageNum = 1;

    for (let p = 0; p < MAX_PAGES && !done; p++) {
      if (Date.now() - startedAt > RUN_TIMEOUT_MS) throw new Error('Run exceeded the 1-hour ceiling.');

      const list = await page.evaluate(pageHarvestList);
      if (!list.length) {
        log('Page ' + pageNum + ': no rows harvested - stopping pager walk.');
        break;
      }
      const newOnPage = list.filter((b) => !seenBoxIds.has(b.boxId));
      log('Page ' + pageNum + ': ' + list.length + ' rows (' + newOnPage.length + ' new).');
      if (!newOnPage.length) {
        // Pager wrapped or stalled - we've seen everything.
        log('No new boxes on this page - list exhausted.');
        break;
      }

      for (const box of newOnPage) {
        if (TARGETED && BOX_IDS.indexOf(box.boxId) === -1) { seenBoxIds.add(box.boxId); continue; }
        if (Date.now() - startedAt > RUN_TIMEOUT_MS) throw new Error('Run exceeded the 1-hour ceiling.');

        let scraped = null;
        for (let attempt = 1; attempt <= 2 && !scraped; attempt++) {
          try {
            const clicked = await page.evaluate(pageClickSelect, box.boxId);
            if (!clicked) throw new Error('Select button not found on current page');
            await page.waitForLoadState('domcontentloaded').catch(() => {});
            await waitForBoxDetails(page, box.boxId);
            await page.waitForTimeout(PAGE_SETTLE_MS);
            scraped = await page.evaluate(pageScrapeDetails);
          } catch (e) {
            log('  Box ' + box.boxId + ' attempt ' + attempt + ' failed: ' + e.message);
            if (attempt === 2) failures.push({ boxId: box.boxId, description: box.description, reason: e.message });
            else await page.waitForTimeout(1500);
          }
        }
        seenBoxIds.add(box.boxId);
        if (!scraped) continue;

        const notes = splitNotes(scraped.Notes);
        results.push({
          boxId: box.boxId,
          description: scraped.Description || box.description,
          cell: scraped.Cell || box.cell,
          haulerAccountRaw: scraped.HaulerAccount != null ? scraped.HaulerAccount : '',
          haulerAccountNorm: normalizeHauler(scraped.HaulerAccount),
          haulerCode: scraped.HaulerCode != null ? scraped.HaulerCode : '',
          notesRaw: scraped.Notes != null ? scraped.Notes : '',
          notesAbove: notes.above,
          notesBelow: notes.below,
          notesHasDivider: notes.hasDivider,
        });
        log('  Box ' + box.boxId + ' OK - HaulerAccount="' + (scraped.HaulerAccount || '') + '" HaulerCode="' + (scraped.HaulerCode || '') + '"'
          + (notes.below ? ' [below-line notes present]' : ''));

        if (TEST_COUNT && results.length >= TEST_COUNT) { done = true; break; }
        if (TARGETED && results.length + failures.length >= BOX_IDS.length) { done = true; break; }
      }

      if (done) break;

      // Advance the pager. The list grid keeps its page across Select
      // postbacks (WebForms ViewState), so ">" moves from wherever we are.
      const advanced = await page.evaluate(pageClickNext);
      if (!advanced) { log('No ">" pager button found/clickable - assuming last page.'); break; }
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(1200);
      pageNum++;
    }

    /* -------------------- OUTPUT -------------------- */

    const stamp = todayStamp();
    const csvPath = path.join(LOG_DIR, 'box-management-' + stamp + '.csv');
    const jsonPath = path.join(LOG_DIR, 'box-management-' + stamp + '.json');

    const header = ['boxId', 'description', 'cell', 'haulerAccountRaw', 'haulerAccountNorm', 'haulerCode', 'notesAbove', 'notesBelow', 'notesHasDivider', 'notesRaw'];
    const csv = [header.join(',')].concat(results.map((r) => header.map((h) => csvEscape(r[h])).join(','))).join('\n');
    fs.writeFileSync(csvPath, csv);
    fs.writeFileSync(jsonPath, JSON.stringify({ date: stamp, count: results.length, failures: failures, results: results }, null, 2));
    log('Wrote ' + results.length + ' boxes to ' + csvPath);
    log('Wrote JSON to ' + jsonPath);

    // -------- HaulerAccount inventory: the whole point of phase 1 -------
    const counts = {};
    for (const r of results) {
      const k = r.haulerAccountNorm === '' ? '(blank)' : r.haulerAccountNorm;
      counts[k] = (counts[k] || 0) + 1;
    }
    const inv = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    const invLines = inv.map((k) => '  ' + String(counts[k]).padStart(4) + '  ' + k);
    const invText = 'HaulerAccount DISTINCT VALUES (' + inv.length + ' spellings across ' + results.length + ' boxes):\n' + invLines.join('\n');
    log('\n' + invText);
    fs.writeFileSync(path.join(LOG_DIR, 'hauler-inventory-' + stamp + '.txt'), invText + '\n');

    // Divider sanity check for the notes split logic.
    const noDivider = results.filter((r) => !r.notesHasDivider && r.notesRaw.trim() !== '');
    if (noDivider.length) {
      log('NOTE: ' + noDivider.length + ' box(es) have non-empty Notes with NO underscore divider - review their notesRaw in the JSON before locking the split logic: '
        + noDivider.slice(0, 15).map((r) => r.boxId).join(', ') + (noDivider.length > 15 ? ', ...' : ''));
    }

    if (failures.length) {
      const lines = failures.map((f) => '  - Box ' + f.boxId + (f.description ? ' (' + String(f.description).slice(0, 60) + ')' : '') + ' - ' + f.reason);
      log('BOXES NOT SCRAPED THIS RUN (' + failures.length + '):\n' + lines.join('\n'));
      if (!TEST_COUNT && !TARGETED) {
        await sendAlert('WasteNet collector: ' + failures.length + ' box(es) not scraped - ' + stamp,
          'The Box Management collector finished, but ' + failures.length + ' box(es) could not be scraped:\n\n' + lines.join('\n'));
      }
    }

    /* -------------------- POST TO APPS SCRIPT (v2.0) -------------------- */

    if (SHOULD_POST && results.length > 0) {
      await postResultsToAppsScript(results, stamp);
    } else if (results.length > 0) {
      log('Local-only run (--test/--box without --post) - nothing was sent to Apps Script.');
    }

    log('=== RUN COMPLETE - ' + results.length + ' boxes in ' + Math.round((Date.now() - startedAt) / 60000) + ' min ===');
    await browser.close();
  } catch (err) {
    log('RUN FAILED: ' + err.message);
    await screenshot(page, 'collector_failure');
    if (!TEST_COUNT && !TARGETED && !LOGIN_ONLY) {
      await sendAlert('WasteNet collector FAILED - ' + todayStamp(),
        'The Box Management collector run failed at ' + ts() + '.\n\nReason: ' + err.message +
        '\n\nA screenshot was saved in /opt/wastenet/logs on the server.' +
        '\n\nThis does NOT affect the main 4:30 AM Monitor scan - it runs independently.');
    }
    await browser.close();
    process.exit(1);
  }
}

main();
