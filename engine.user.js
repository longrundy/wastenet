// ==UserScript==
// @name         WasteNet Box Monitor Scan
// @namespace    wastenet
// @version      4.11
// @match        http://h1.ces-web.com/*
// @match        https://h1.ces-web.com/*
// @grant        none
// ==/UserScript==
//
// v4.11 CHANGE: INLINE PER-BOX RETRY on chart-update timeout. Previously a
// box whose chart didn't refresh within PER_BOX_TIMEOUT_MS was immediately
// written as a null placeholder ("Chart did not update...") and skipped -
// meaning a box that briefly hiccuped got no reading and would NOT surface
// in Action Needed even if full. Now, on timeout, the engine re-selects the
// SAME box up to MAX_TIMEOUT_RETRIES (1) times before giving up; a transient
// CES hiccup almost always clears on the immediate retry. The retry count is
// keyed by boxId in the persisted state (timeoutRetryBoxId/timeoutRetryCount)
// so it survives reloads and resets naturally when the scan moves to a
// different box. Only after the retry is exhausted is the placeholder written
// (now noting "retried 1x"). This pairs with the runner's coverage check,
// which emails the exact box IDs if a box is STILL unverified after retries -
// so nothing can fail silently. No other scan logic changed.
//
// v4.10 CHANGE: MONITOR-NOT-REPORTING DETECTION (Stage 1 - DETECTION +
// COUNT ONLY; NO bucketing/serviceNeeded change). CES records the fixed
// value 75000 in the Percent Full column when a box's monitor is not
// sending data. This is a STANDALONE SENTINEL - not a 75/000 split, so
// there is no reason code "75"; the whole 75000 is one value. A 2-digit
// reason code (from the 44-97 list) may be stacked in FRONT of it to say
// why, e.g. 4575000 = reason 45 (compactor repairs) + 75000.
// classifyMonitorSentinel() matches exactly "75000" or "<2 digits>75000"
// on a digits-only reduction. getServiceHistoryInfo() now also returns
// the Percent Full text of the newest AND second-newest completed rows
// (lastPercentRaw / prevPercentRaw); the newest is classified to set
// monitorNotReporting (+ monitorReasonCode when stacked), and the
// previous is classified to set monitorPrevSentinel so a --test/full run
// can report the count split as "latest only" vs "last two agree" and we
// can pick the strictness rule from real data. WHY THIS MATTERS: when the
// monitor is dark the pixel-based fill read is meaningless (e.g. box 906
// phantom-reads 101%), so it can wrongly land in Action Needed OR, via
// closed-day/empty suppression, in No Action - the sentinel is the only
// trustworthy signal. This pass ONLY surfaces + counts the signal (new
// result fields, appended payload fields, an end-of-run cron.log summary,
// and console-CSV columns). It deliberately does NOT change serviceNeeded
// or any bucket; the "Monitor Down" bucket + Apps Script sheet columns
// come in Stage 2 once the count is known. daysSinceService /
// lastServiceDate semantics are unchanged (still the newest completed
// row); getServiceHistoryInfo simply reads one extra row now.
//
// v4.9 CHANGE: SCHEDULED-PICKUP DETECTION (Stage 1). CES marks a
// pickup that has been scheduled but not yet recorded as a distinct
// row in the Last 400 Days table - Date and Days present, Percent Full
// and Cycle Count blank, and (the reliable tell, confirmed by DOM
// inspection) a "Delete" submit button in its Action cell
// (name="LastNDays1$DeleteButton1"), where completed rows have only
// "Update Weight". getScheduledPickupInfo() finds that row and returns
// its scheduled date. A box CES shows as scheduled is reported
// serviceNeeded=false (it's already booked - no action needed),
// OVERRIDING any upstream trigger/set-schedule YES, and carries new
// scheduledPickup=true / scheduledDate fields plus a "SCHEDULED:" note.
// This is an OBSERVED CES FACT and is deliberately SEPARATE from
// WasteNet's own Scheduled/Notified/Confirmed workflow tracking (driven
// by dashboard actions, not by the scan). v4.8's empty-detection is
// untouched: the scheduled row already fails the four-cells-populated
// rule, so days-since-empty is unaffected.
//
// v4.8 CHANGE: DATA-PRESENCE SERVICE DETECTION. The "last empty" is
// now found by data presence, not row color. In the Last 400 Days
// table a row counts as a completed empty when all four of Date,
// Days, Percent Full, and Cycle Count are filled in (tested as
// non-blank text, so a literal 0 still counts); the newest such row
// is the last service. This replaces the old yellow/cornflowerblue/
// lightcoral color matching, which misclassified box 139's 07/06
// empty as an open request - anchoring days-since-empty to the prior
// 06/26 empty (Days 11 of 7) and forcing a false YES. The related
// "REQUESTED mm/dd" advisory token is removed: without color we no
// longer distinguish an ordered request from a completed empty, and
// per the decision the advisory now speaks in empties only. No
// serviceNeeded logic changed; only how last-empty is read.
//
// v4.7 CHANGE: SET-SCHEDULE FORCING. Boxes with a WasteNet-managed
// Set Schedule (Master Box List column K, e.g. "Every Friday") now
// force serviceNeeded=YES on the day their pull must be ORDERED, not
// the day it happens: the next scheduled pull day is worked backwards
// through the box's Scheduling Rule (column J - NBD/1-BD/2-BD, same
// business-day + core-6-holiday math as the dashboard's suggested
// date), so a Friday pull under a 2-BD rule surfaces on Action Needed
// starting Tuesday. The force stays on every day from the order day
// through the pull day (a missed Tuesday still flags Wednesday), and
// clears through the existing requested-within-SUPPRESS_DAYS
// suppression once the order is placed. The chart's Empty marker does
// NOT suppress it - a set-schedule pull is ordered on schedule, not
// on fill. Exclusions: "Never Schedule" boxes (hauler self-manages -
// WasteNet must NOT order) and any Set Schedule mentioning "by
// Hauler" (hybrids like Box 1030 - the hauler-owned days are theirs;
// those boxes stay purely reading-driven here). Boxes with a Set
// Schedule but NO Scheduling Rule default to ordering one business
// day ahead (NBD-equivalent). Requires the matching Code.gs update:
// ?action=days_cycles now delivers each box's Scheduling Rule as 'r'
// alongside the existing 's' Set Schedule text.
//
// v4.6 CHANGE: every result now carries lastCycleHours - the "Last
// Cycle: N hours/days" reading from the box page - for ALL boxes, not
// just forced-YES/stale ones. The scanner always read this value; it
// just discarded it for normal boxes. It now rides the payload as its
// own field (and CSV column) so the dashboard's Box Data panel can
// show "Last Cycle: 7.6 hours" on every box. Requires the matching
// Code.gs update (Last Cycle Hrs column, appended as column 20).
//
// v4.5.1 FIX (found in live testing, same night): clicking Logout
// parks the browser on a THIRD url - Default.aspx - which the v4.5
// match rules didn't cover, so the script never woke up there and
// auto-login never fired. (login.aspx is only where EXPIRED sessions
// get redirected; deliberate logouts land on Default.aspx.) The match
// now covers EVERY page on h1.ces-web.com, and init() decides by
// looking at where it actually is: a login form -> auto-login;
// Monitor.aspx -> the normal scanner; ANY other page (Default.aspx or
// anything else the portal invents) -> when Auto-Run is enabled,
// navigate back to Monitor.aspx (rate-limited to once a minute, so a
// surprise page can never cause a rapid reload loop). Monitor.aspx
// with no session redirects to login.aspx by itself, where auto-login
// picks it up - so from ANY parked state the chain self-heals:
// anywhere -> Monitor -> login -> Monitor.
//
// For every box on the Box Monitor page (Monitor.aspx):
//   1. Force the correct Trend Graph #1 display checkbox - "Show ABox"
//      checked (A1/A3 unchecked) for most boxes, except the 26 boxes
//      listed in A3_BOX_IDS below, which get "Show A3" checked instead
//      (ABox/A1 unchecked). "Show A1" is never used in this version.
//   2. Set "Set No. Cycles" to 50 (if not already), so the chart shows
//      exactly the window we want to evaluate.
//   3. Read the chart: does the plotted data line sit at or above the
//      chosen trigger line anywhere in that 50-cycle window? WHICH
//      trigger depends on today's day of the week:
//        - Thursday or Friday -> compare against Trigger2 (blue line)
//        - Monday, Tuesday, Wednesday, Saturday, Sunday -> compare
//          against Trigger1 (red line)
//   4. Service needed = YES if it crosses the chosen trigger - UNLESS
//      "Date Pull Requested" is within the last 3 calendar days, OR the
//      chart's own Empty marker appears in the current window, either
//      of which downgrades the result to NO (already requested
//      recently, or the box was actually emptied recently - don't ask
//      again).
//   5. Set "Set No. Cycles" back to 300 (cleanup) before moving to the
//      next box.
//
// v4.5 CHANGES (three features - the scanner can now run itself):
//
// 1. AUTO-RUN. A schedule built into the panel (default 5:55 AM,
//    every day): when Auto-Run is enabled and the clock passes the
//    target time on a day with no scan yet, a FULL scan starts on its
//    own - same scan, same upload, no human. A once-per-day guard
//    (localStorage) prevents double runs; a run WINDOW (target time
//    until noon) means a machine that was asleep at 5:55 but wakes at
//    8 still runs, while a 6 PM wake-up skips the day rather than
//    producing a useless evening tab. Requires: this computer set to
//    never sleep, Chrome left running, and this tab left open on
//    Monitor.aspx overnight.
//
// 2. AUTO-LOGIN. An expired session redirects to a dedicated login
//    page (h1.ces-web.com/login.aspx?Returnurl=...), so this script
//    now ALSO matches login.aspx - a new @match line above, which is
//    why updating to v4.5 shows Tampermonkey asking to approve the
//    additional page. When the script finds itself on the login form
//    (detected structurally: a password field present, no box grid),
//    it fills saved credentials, ticks "Remember me next time", and
//    clicks Log In - the Returnurl then lands it back on the monitor
//    page, where the auto-run alarm takes over. Credentials are saved
//    ONCE via the panel's Auto-Run section (only shown while logged
//    in) and stored in this browser's localStorage - NOT in this
//    file. Honest tradeoff: anyone with access to this computer's
//    browser could recover them; keep this on a work machine. Field
//    detection is structural (the only password input on the page,
//    the text input before it, the only checkbox, the Log In submit)
//    - no guessed ASP.NET IDs. Login attempts are rate-limited to one
//    per minute so bad credentials can't hammer the portal.
//
// 3. KEEP-ALIVE. While Auto-Run is enabled and no scan is active,
//    the page quietly reloads every 15 minutes - keeping the session
//    warm overnight, and if a reload lands on the login form, the
//    auto-login brings it back: a self-healing loop. The reload is
//    skipped while the tab has focus (so it never yanks the page out
//    from under a human) and always skipped mid-scan.
//
// 4. SET SCHED advisory marker. The Days & Cycles fetch now also
//    carries each box's Set Schedule text (Master Box List column K,
//    joined server-side by the Apps Script). The advisory string
//    gains a trailing marker: "NEVER SCHED" for hauler-self-managed
//    boxes (do NOT order pulls) or "SET SCHED" for named-day standing
//    schedules WasteNet is responsible for ordering. Informational
//    only - YES/NO logic remains untouched. Requires the Code.gs
//    version that joins column K into ?action=days_cycles (deployed
//    2026-07-05).
//
// v4.4 CHANGES (two features):
//
// 1. CLOSED-DAY AWARE "Last Cycle" CHECK. The flat 24-hour forced-YES
//    rule caused false flags every Sunday/Monday and after holidays
//    for boxes at sites that close on certain days (a box that ran
//    Friday evening legitimately shows "26+ hours" on Sunday morning).
//    The scanner now reads the Daily Cycle Count grid
//    (CycleCount1_CycleCountGridView): the Yellow-highlighted row is
//    the current in-progress week and is EXCLUDED; the remaining
//    complete weeks (need at least 4) vote per weekday - a weekday is
//    considered "closed" when 4 or more complete weeks show ZERO
//    cycles on that day. The 24h threshold is then extended by 24h
//    for each consecutive closed day walking backward from yesterday
//    (Option B): e.g. closed Sat+Sun -> Monday-morning threshold is
//    72h. Boxes with fewer than 4 complete weeks of grid history (or
//    no grid at all) fall back to the flat 24h rule, exactly as
//    before. Known limitation, accepted: one-off holiday closures on
//    normally-open weekdays are NOT detected and will still force YES.
//
// 2. DAYS & CYCLES ADVISORY (informational only - YES/NO logic is
//    completely untouched). At scan start, per-box trigger values are
//    fetched from the Google Sheet's "Days & Cycles" tab (column D =
//    Days Trigger, column E = Cycle Trigger) via the Apps Script's
//    new ?action=days_cycles endpoint - JSONP, one fetch per run,
//    riding in saved state across reloads, exactly like the Green
//    List; any fetch failure just means "no trigger comparison this
//    run" and can never stop the scan. On every scanned box page the
//    script reads:
//      - Days since last completed service: the NEWEST row of the
//        Last 400 Days table (LastNDays1_Table1) with all four of
//        Date, Days, Percent Full, and Cycle Count populated - the
//        completed-service marker (see v4.8; superseded the old
//        Yellow-background rule). Rows are newest-first; today's
//        running-status row lacks Percent Full and is skipped.
//      - Current cycles since last empty: the "Standard Cycles" line
//        (span#CycleLabel, "Cycle N /") - resets to 0 at each empty.
//    These combine into a new Advisory field on every result, e.g.
//      "Days: 11 of 7 | Cycles: 123 of 230"
//    ("of X" parts are omitted for boxes with no/N-A trigger values;
//    page parts are omitted when unreadable). Advisory is a new
//    column in both the console CSV and the Google Sheets upload -
//    NOTE: requires the matching Apps Script update (days_cycles
//    endpoint + Advisory column in the tab writer) deployed as a new
//    version.
//
// v4.3 CHANGE: the Show A3 (green line) box list is now DYNAMIC. At
// the start of every scan run, the list is fetched from the "Green
// List Box A3" tab of the Google Sheet (via the same Apps Script the
// results already upload to - new ?action=green_list endpoint, loaded
// JSONP-style since Apps Script URLs can't be fetch()ed cross-origin),
// stored in the saved scan state, and reused across every page reload
// of the run - one fetch per scan, not per box. Adding a box to the
// green list is now just typing its ID on that tab; NO script edit or
// redeploy needed. If the fetch fails for any reason (network, sheet
// unavailable), the scan falls back to the built-in A3_BOX_IDS list
// below and says so in the log - a bad morning can never stop the
// daily scan. Boxes 697 and 713 added to the built-in fallback list
// (28 boxes) so they're covered even in the fallback case.
//
// v4.2 CHANGE: A3_BOX_IDS replaced with the full, explicit, confirmed
// list of 26 boxes (18, 72, 76, 83, 96, 120, 132, 165, 225, 474, 509,
// 523, 528, 541, 627, 661, 663, 746, 794, 796, 840, 925, 955, 972, 973,
// 1009), provided directly as the authoritative source of truth rather
// than incrementally adding individual boxes on top of guesswork. No
// other behavior changed from v4.1's bug fixes, which are preserved
// below (bottom-right date check removed, Empty-marker shape detection,
// resume-after-reload trust fix).
//
// v4.1 CHANGE (carried forward): the second, redundant suppression
// signal - reading the bottom-right "Last N Days" table for a recent
// completed cycle date - was removed entirely per explicit request.
// Date Pull Requested is now the only date-based suppression check,
// separate from (and independent of) the chart's own Empty marker
// detection, which still applies on its own.
//
// v4.0 CHANGE: removed the v3.0 parallel two-tab feature entirely. It
// worked, but it materially increased server load, and that extra load
// was directly responsible for a real bug - several different boxes in
// a parallel run all came back reporting the same impossible ~100.5%
// reading, traced to the chart-update wait silently timing out and
// falling through to analyze whatever (possibly stale) image happened
// to be on screen. That specific bug is now fixed too (see
// chartFreshnessUnverified below - an unconfirmed chart is refused, not
// guessed at), but given the actual speed gain from two tabs was modest
// and the single-tab path is simpler and has fewer ways to fail, this
// version goes back to one tab only. CHART FRESHNESS FIX (kept from the
// investigation, applies regardless of single- or two-tab running): if
// the chart's image never visibly updates within PER_BOX_TIMEOUT_MS
// after changing "Set No. Cycles", the script no longer assumes the
// stale image on screen is safe to read - it refuses to analyze it and
// reports the box as unreadable (defaults to NO, with a clear note)
// instead of risking a fabricated, confident-looking number.
//
// RESUME-AFTER-RELOAD FIX (kept from the investigation): clicking
// "Set No. Cycles" triggers a FULL PAGE RELOAD on this site, every
// time, with no exception - that reload destroys the in-browser
// JavaScript that was waiting to observe the chart's src change, before
// it ever gets the chance to see it. The script therefore falls back to
// resuming from saved progress after the reload completes - this is the
// NORMAL, EXPECTED path on every single box, not a sign of staleness.
// A resume that lands back in phase3 (the analysis step) immediately
// after such a reload is correctly TRUSTED here (chartFreshnessUnverified
// = false on that resume path), since the reload itself IS the
// legitimate chart update completing. The chart-freshness-unverified
// safety check above still applies to genuine timeout cases (e.g. the
// chart never updates at all within PER_BOX_TIMEOUT_MS even after
// allowing for the reload) - it is simply no longer misapplied to the
// ordinary, successful reload-and-resume path that runs on every box.
//
// IMPORTANT COLOR NOTE: the data line is NOT the same color in every
// mode. Confirmed by direct pixel sampling of real chart PNGs:
//   - "Show ABox" mode ("Algorithm in Box" series): light/sky blue,
//     rgb(72,145,241)
//   - "Show A3" mode ("Server Algorithm #3" series): green,
//     rgb(0,128,0)
// These are NOT interchangeable - using the wrong color for a given
// mode would mean the real data line is never detected at all (same
// class of bug as the old Trigger1-only script's wrong-color issue).
// The two trigger lines themselves are constant across both modes:
// Trigger1 = pure red rgb(255,0,0), Trigger2 = pure blue rgb(0,0,255).
// Gridlines are also unchanged: black, 6 lines at 0/20/40/60/80/100%.
//
// EMPTY MARKER DETECTION: the chart draws its own "Empty" marker - a
// red, roughly square blob - at the 0% line whenever the box was
// recorded as physically emptied at some point in the visible window.
// It's drawn in the SAME pure red as the Trigger1 line, so color alone
// can't distinguish them; the distinguishing signature is SHAPE. The
// Trigger1 line is a long, thin, near-full-width band. The Empty marker
// is a compact, roughly square blob sitting right on/near the bottom
// (0%) gridline. Detected via 2D proximity clustering (not column-only
// grouping, which would incorrectly merge the marker into the same run
// as the trigger line) - a red cluster only counts as the Empty marker
// if its column span is much narrower than the full plot width AND its
// row span is notably taller than a single gridline.
//
// Built on the same proven patterns as the earlier "WasteNet Monitor
// Zone Scanner", "WasteNet Trigger Point Updater", and the original
// "WasteNet Box Service Check (Trigger1 / 50-Cycle)" scripts:
//   - getBoxRows() / selectRow() to walk the box grid via __doPostBack
//   - label-adjacent-button field read/write (the input is the button's
//     previousElementSibling)
//   - ONE checkbox click per turn, re-checking real DOM state after
//     each click, since a checkbox click can trigger a FULL PAGE
//     POSTBACK that would silently drop any second click queued right
//     after the first
//   - resumable localStorage state, tracking exactly which phase was
//     in progress, so a mid-box full-page reload resumes correctly
//     instead of restarting all phases or getting stuck forever
//   - Stop takes effect immediately (not just at the next box
//     boundary), and an unfinished scan found on page load only
//     auto-resumes if it looks like a genuine in-flight script reload
//     (within 15 seconds) - otherwise it asks before continuing
//   - if the chart can't be read for ANY reason (no image rendered,
//     gridlines undetectable, data-line color not found, trigger value
//     missing, OR chart freshness unverified - see v4.0 note above),
//     the result defaults to NO (not null/unknown) so the box still
//     completes its cleanup and the scan keeps moving, with the real
//     reason preserved in `notes`
//   - gridline-detection + data-line-color pixel analysis on the chart
//     <img>, calibrated off the chart's own gridlines rather than fixed
//     pixel coordinates, including the median-gap extrapolation fix
//     for a possibly-undetected top/100% gridline
//
// USAGE
//   1. Open http://h1.ces-web.com/Monitor.aspx and log in.
//   2. A small panel appears in the top-right corner.
//   3. Click "Run Service Check" to start. Test mode is available for a
//      small batch first.
//   4. Click "Stop" any time; progress is saved and resumes on reload.
//   5. When done, a CSV summary is printed to the console (F12 > Console),
//      and results are uploaded to the Google Sheet automatically.

(function () {
  'use strict';

  const STORAGE_KEY = 'box_service_check_v2_state';
  const PER_BOX_TIMEOUT_MS = 6000;
  // v4.11: on a per-box chart-update timeout, re-select the SAME box this
  // many times before giving up and writing the placeholder. A transient CES
  // hiccup almost always clears on the immediate next try, so 1 retry catches
  // the vast majority while adding at most ~6s to a box that was going to fail
  // anyway. The runner's coverage check (#1) is the backstop if a retry also fails.
  const MAX_TIMEOUT_RETRIES = 1;
  const POLL_INTERVAL_MS = 150;
  const SCAN_CYCLES = 50;
  const RESET_CYCLES = 300;
  const SUPPRESS_DAYS = 3;
  const RESUME_STALE_MS = 15000;

  const GOOGLE_SHEETS_WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbwc3siwl0OTP2O5WzNZCDn4cj3MDVRfcVxJW0TZtoPnAKLwhYSwmW_m1h7ib6Yf_Dvk9w/exec';
  const GOOGLE_SHEET_VIEW_URL = 'https://docs.google.com/spreadsheets/d/18q7B4a2WLmnSnvAQ51u8D5Wy4_mfSIeCKBFVsl39lfc/edit?usp=sharing';

  // FALLBACK list of boxes that should show Algorithm #3 instead of
  // ABox on Trend Graph #1. As of v4.3 the AUTHORITATIVE list lives on
  // the Google Sheet's "Green List Box A3" tab, fetched at scan start
  // (see fetchGreenListFromSheet / isA3Box below) - this constant is
  // only used when that fetch fails, so it should still be kept
  // roughly current. (28 boxes as of v4.3 - 697 and 713 added.)
  const A3_BOX_IDS = new Set([
    '18', '72', '76', '83', '96', '120', '132', '165', '225', '474',
    '509', '523', '528', '541', '627', '661', '663', '697', '713', '746',
    '794', '796', '840', '925', '955', '972', '973', '1009',
  ]);

  // Fetches the Green List (Show A3 box IDs) from the Google Sheet's
  // "Green List Box A3" tab via the Apps Script's ?action=green_list.
  // Loaded JSONP-style (a <script> tag calling back into a one-off
  // global function) because Apps Script Web App URLs 302-redirect
  // internally, which strips CORS headers and blocks a normal fetch()
  // from this page - the same reason the dashboard reads this way.
  // Resolves with an array of Box ID strings on success, or null on
  // ANY failure (timeout, network error, sheet error) so the caller
  // can fall back to the built-in list - this promise never rejects.
  function fetchGreenListFromSheet() {
    return new Promise((resolve) => {
      const cbName = 'wastenetGreenList_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
      const script = document.createElement('script');
      let settled = false;
      const finish = (ids) => {
        if (settled) return;
        settled = true;
        try { delete window[cbName]; } catch (e) {}
        if (script.parentNode) script.parentNode.removeChild(script);
        clearTimeout(timeoutId);
        resolve(ids);
      };
      window[cbName] = (data) => {
        if (data && data.ok && Array.isArray(data.boxIds) && data.boxIds.length > 0) {
          finish(data.boxIds.map(String));
        } else {
          finish(null);
        }
      };
      const timeoutId = setTimeout(() => finish(null), 10000);
      script.onerror = () => finish(null);
      script.src = GOOGLE_SHEETS_WEBHOOK_URL + '?action=green_list&callback=' + cbName;
      document.head.appendChild(script);
    });
  }

  // Single source of truth for "does this box use Show A3?" - the
  // sheet-fetched list stored in the scan state when available (an
  // array, since state must survive JSON round-trips through
  // localStorage on every page reload), the built-in fallback Set
  // otherwise. ~30 entries, so indexOf is plenty fast.
  function isA3Box(boxId, state) {
    const list = state && state.greenListBoxIds;
    if (Array.isArray(list) && list.length > 0) {
      return list.indexOf(String(boxId)) !== -1;
    }
    return A3_BOX_IDS.has(String(boxId));
  }

  function isInactiveBoxDescription(description) {
    return /^[xyz]/i.test((description || '').trim());
  }

  function getActiveTriggerChoice() {
    const day = new Date().getDay();
    return (day === 4 || day === 5) ? 'trigger2' : 'trigger1';
  }

  function getBoxId() {
    const m = document.body.innerText.match(/Box:\s*(\d+)/);
    return m ? m[1] : '';
  }

  function getTrendGraphImg() {
    return document.querySelector("img[id*='TrendGraph1']");
  }

  function findFieldInput(labelText) {
    const btn = [...document.querySelectorAll('input')].find((i) => i.value === labelText);
    if (!btn) return null;
    const input = btn.previousElementSibling;
    if (!input) return null;
    return { btn, input };
  }

  function getFieldValue(labelText) {
    const found = findFieldInput(labelText);
    if (!found) return null;
    const raw = found.input.value.trim();
    if (raw === '') return null;
    const num = parseFloat(raw);
    return isNaN(num) ? null : num;
  }

  function setFieldValue(labelText, value) {
    const found = findFieldInput(labelText);
    if (!found) throw new Error('Could not find field "' + labelText + '".');
    const current = parseFloat(found.input.value.trim());
    if (current === value) return false;
    found.input.value = String(value);
    found.input.dispatchEvent(new Event('input', { bubbles: true }));
    found.input.dispatchEvent(new Event('change', { bubbles: true }));
    found.btn.click();
    return true;
  }

  function getLastCycleHours() {
    const el = [...document.querySelectorAll('*')].find(
      (e) => e.children.length === 0 && /Last Cycle\s*:/i.test(e.textContent || '')
    );
    if (!el) return null;
    const match = (el.textContent || '').match(/Last Cycle\s*:\s*([\d.]+)\s*(hour|day)/i);
    if (!match) return null;
    const value = parseFloat(match[1]);
    if (isNaN(value)) return null;
    const unit = match[2].toLowerCase();
    return unit === 'day' ? value * 24 : value;
  }

  // ---- v4.4: closed-day detection (Daily Cycle Count grid) ----
  // Reads CycleCount1_CycleCountGridView. Header row is Mon..Sun (th
  // cells); data rows run OLDEST to NEWEST top-to-bottom; the current
  // in-progress week's cells carry background-color:Yellow and are
  // excluded (their future days read 0 and would poison the vote).
  // Returns a Set of closed weekday column indices (0=Mon .. 6=Sun),
  // or null when there are fewer than 4 complete weeks to vote with.
  function getClosedWeekdayColumns() {
    const table = document.getElementById('CycleCount1_CycleCountGridView');
    if (!table) return null;
    const completeWeeks = [];
    for (const tr of table.querySelectorAll('tr')) {
      const tds = [...tr.children].filter((c) => c.tagName === 'TD');
      if (tds.length !== 7) continue; // header (th) row, or partial row
      const isCurrentWeek = tds.some((td) =>
        /yellow/i.test(td.getAttribute('style') || '')
      );
      if (isCurrentWeek) continue;
      const counts = tds.map((td) => parseInt((td.textContent || '').trim(), 10));
      if (counts.some((n) => isNaN(n))) continue;
      completeWeeks.push(counts);
    }
    if (completeWeeks.length < 4) return null;
    const closed = new Set();
    for (let col = 0; col < 7; col++) {
      let zeros = 0;
      for (const week of completeWeeks) {
        if (week[col] === 0) zeros++;
      }
      if (zeros >= 4) closed.add(col);
    }
    return closed;
  }

  // Option B threshold: 24h base, +24h for each CONSECUTIVE closed day
  // walking backward from yesterday (capped at 6 - a box "closed" all
  // 7 days would otherwise loop forever, and such a box is exactly the
  // kind that deserves a look anyway). Returns
  // { thresholdHours, closedDaysCounted, gridUsable }.
  function computeLastCycleThreshold() {
    const closed = getClosedWeekdayColumns();
    if (!closed || closed.size === 0) {
      return { thresholdHours: 24, closedDaysCounted: 0, gridUsable: !!closed };
    }
    let extra = 0;
    for (let i = 1; i <= 6; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const col = (d.getDay() + 6) % 7; // JS 0=Sun..6=Sat -> grid 0=Mon..6=Sun
      if (closed.has(col)) extra++;
      else break;
    }
    return { thresholdHours: 24 * (1 + extra), closedDaysCounted: extra, gridUsable: true };
  }

  // ---- v4.4: Days & Cycles advisory page readers ----
  // ---- v4.8: DATA-PRESENCE service detection (color-independent) ----
  // Last 400 Days table (LastNDays1_Table1), rows newest-first. Each
  // row has 6 cells: [0]=Date [1]=Days [2]=Percent Full [3]=Cycle
  // Count [4]=Weight [5]=Action. A row is a COMPLETED EMPTY when all
  // four of Date, Days, Percent Full, and Cycle Count are filled in -
  // regardless of the row's background color. (Today's running-status
  // row has a Date and Days but no Percent Full, so it is skipped; an
  // ordered-but-unfulfilled request likewise lacks the completed
  // Percent Full / Cycle Count, so it is not mistaken for an empty.)
  // The newest row that passes is the last real service. This replaces
  // the old yellow/cornflowerblue/lightcoral color matching, which
  // misread rows when CES rendered a cell with a hex color or a
  // different shade (e.g. box 139's 07/06 empty read as a request).
  // Returns { daysSinceService, lastServiceDate } (each null when not
  // found) or null when the table is absent. openRequestDate removed.
  function getServiceHistoryInfo() {
    const table = document.getElementById('LastNDays1_Table1');
    if (!table) return null;
    // A cell counts as filled when it holds any non-blank text. Tested
    // as an empty-string check (NOT truthiness) so a literal 0 - a real
    // 0% full or 0 cycle count - still counts as a populated entry.
    const filled = (td) => td && (td.textContent || '').trim() !== '';
    let lastServiceDate = null;
    // v4.10: also capture the Percent Full text of the newest completed
    // row (lastPercentRaw) and the second-newest (prevPercentRaw). These
    // feed monitor-not-reporting sentinel detection. Reading a second row
    // is the ONLY behavioural change here; lastServiceDate is still the
    // newest completed row exactly as before.
    let lastPercentRaw = null;
    let prevPercentRaw = null;
    let populatedSeen = 0;
    for (const tr of table.querySelectorAll('tr')) {
      const tds = [...tr.children].filter((c) => c.tagName === 'TD');
      if (tds.length < 4) continue; // header or malformed row
      const dateText = (tds[0].textContent || '').trim();
      if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(dateText)) continue; // header etc.
      // The four-cells-populated rule: Date, Days, Percent Full, Cycle Count.
      if (!(filled(tds[0]) && filled(tds[1]) && filled(tds[2]) && filled(tds[3]))) {
        continue;
      }
      const pctText = (tds[2].textContent || '').trim();
      if (populatedSeen === 0) {
        // newest completed row = the last real service (unchanged semantics)
        const parsed = new Date(dateText);
        if (!isNaN(parsed.getTime())) lastServiceDate = parsed;
        lastPercentRaw = pctText;
      } else {
        prevPercentRaw = pctText; // second-newest completed row
      }
      populatedSeen++;
      if (populatedSeen >= 2) break; // have newest + previous; done
    }
    let daysSinceService = null;
    if (lastServiceDate) {
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const svc = new Date(
        lastServiceDate.getFullYear(), lastServiceDate.getMonth(), lastServiceDate.getDate()
      );
      daysSinceService = Math.round((today - svc) / 86400000);
    }
    return { daysSinceService, lastServiceDate, lastPercentRaw, prevPercentRaw };
  }

  // v4.10: MONITOR-NOT-REPORTING sentinel classifier. CES records the
  // fixed value 75000 in the Percent Full column when a box's monitor is
  // not sending data. It is NOT a 75/000 split - the whole 75000 is one
  // sentinel, so there is no reason code "75". A 2-digit reason code (from
  // the 44-97 list) may be stacked in FRONT of it to say why the monitor
  // is dark, e.g. 4575000 = reason 45 (compactor repairs) + 75000.
  // Returns { isSentinel, reasonCode } where reasonCode is the leading two
  // digits (string) when stacked, else null. Everything but digits is
  // stripped first so stray formatting/whitespace cannot defeat the match.
  function classifyMonitorSentinel(raw) {
    const digits = String(raw == null ? '' : raw).replace(/\D/g, '');
    if (digits === '75000') return { isSentinel: true, reasonCode: null };
    const m = /^(\d{2})75000$/.exec(digits);
    if (m) return { isSentinel: true, reasonCode: m[1] };
    return { isSentinel: false, reasonCode: null };
  }

  // ---- v4.9: SCHEDULED-PICKUP detection (Delete-button signal) ----
  // A pickup that has been SCHEDULED in CES but not yet recorded shows
  // as a distinct row in the Last 400 Days table: it has a Date and Days
  // but blank Percent Full / Cycle Count (so getServiceHistoryInfo above
  // correctly does NOT treat it as a completed empty), and - the
  // reliable tell, confirmed by DOM inspection - its Action cell carries
  // BOTH a "Weight" submit button AND a "Delete" submit button
  // (name="LastNDays1$DeleteButton1"), whereas a completed row has only
  // an "Update Weight" button. The Delete button is the structural
  // signal. This function finds the newest row whose Action cell
  // contains a Delete control and returns its scheduled pickup date.
  //
  // IMPORTANT: this is an OBSERVED FACT from CES ("CES shows a pickup
  // scheduled for this date"). It is entirely separate from WasteNet's
  // own Scheduled/Notified/Confirmed workflow tracking, which is driven
  // by dashboard actions, not by the scan. This detection only tells the
  // scanner the box is already scheduled so it can be pulled out of
  // "action needed" and its scheduled date surfaced.
  //
  // Returns { scheduledDate: Date|null } or null when the table is absent.
  function getScheduledPickupInfo() {
    const table = document.getElementById('LastNDays1_Table1');
    if (!table) return null;
    for (const tr of table.querySelectorAll('tr')) {
      const tds = [...tr.children].filter((c) => c.tagName === 'TD');
      if (tds.length < 5) continue; // need at least through the Action cell
      const dateText = (tds[0].textContent || '').trim();
      if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(dateText)) continue; // header / non-data row
      // Look in the Action cell (last cell) for a Delete control. Primary
      // signal: an input/button whose name contains "DeleteButton";
      // fallback: value/text exactly "Delete".
      const actionCell = tds[tds.length - 1];
      const controls = [...actionCell.querySelectorAll('input, button, a')];
      const hasDelete = controls.some((el) => {
        const name = (el.getAttribute && el.getAttribute('name')) || el.name || '';
        const val = (el.value || el.textContent || '').trim();
        return /DeleteButton/i.test(name) || /^delete$/i.test(val);
      });
      if (!hasDelete) continue;
      const parsed = new Date(dateText);
      return { scheduledDate: isNaN(parsed.getTime()) ? null : parsed };
    }
    return { scheduledDate: null };
  }

  // "Standard Cycles" line: <span id="CycleLabel">Cycle 471 /</span>.
  // The authoritative current-cycles-since-last-empty counter (resets
  // to 0 at each empty). Returns a number or null.
  function getCurrentCycleCount() {
    const el = document.getElementById('CycleLabel');
    if (!el) return null;
    const m = (el.textContent || '').match(/Cycle\s+([\d,]+)\s*\//i);
    if (!m) return null;
    const n = parseInt(m[1].replace(/,/g, ''), 10);
    return isNaN(n) ? null : n;
  }

  // Composes the informational advisory string for the box currently
  // on screen, e.g. "Days: 11 of 7 | Cycles: 123 of 230". Never
  // throws; returns '' when nothing is readable. Does NOT influence
  // serviceNeeded in any way.
  function buildAdvisoryForCurrentBox(boxId, state) {
    try {
      const map = state && state.daysCyclesMap;
      const trig = map ? map[String(boxId)] : null;
      const hist = getServiceHistoryInfo();
      const cycles = getCurrentCycleCount();
      const parts = [];
      if (hist && hist.daysSinceService !== null) {
        let p = 'Days: ' + hist.daysSinceService;
        if (trig && trig.d !== null && trig.d !== undefined) p += ' of ' + trig.d;
        parts.push(p);
      }
      if (cycles !== null) {
        let p = 'Cycles: ' + cycles;
        if (trig && trig.c !== null && trig.c !== undefined) p += ' of ' + trig.c;
        parts.push(p);
      }
      // v4.8: REQUESTED token removed - service detection is now
      // data-presence based and no longer distinguishes an open
      // request from an empty; the advisory speaks in empties only.
      // v4.5: Set Schedule marker from Master Box List column K,
      // delivered in the days_cycles map as 's'. v4.7: when the box
      // is inside its order window, the marker carries the pull it's
      // due for, so the sheet/dashboard show WHY it was forced.
      if (trig && trig.s) {
        if (/^never\s+schedule/i.test(String(trig.s).trim())) {
          parts.push('NEVER SCHED');
        } else {
          const due = computeSetScheduleDue(boxId, state);
          parts.push(due
            ? (due.late
              ? 'SET SCHED - ORDER OVERDUE FOR ' + formatShortDay(due.pullDate) + ' PULL'
              : 'SET SCHED - ORDER BY ' + formatShortDay(due.orderDate) + ' FOR ' + formatShortDay(due.pullDate) + ' PULL')
            : 'SET SCHED');
        }
      }
      return parts.join(' | ');
    } catch (e) {
      return '';
    }
  }

  // ---- v4.7: set-schedule order-day math ----
  // Mirrors the dashboard's business-day machinery (same core-6
  // holidays, same observed-date shifts) so the day this scanner
  // forces a box is exactly the day the dashboard's suggested date
  // for it lands on the scheduled pull.
  function ymdKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function nthWeekdayOfMonth(year, monthIndex, weekday, n) {
    if (n > 0) {
      const first = new Date(year, monthIndex, 1);
      const day = 1 + ((weekday - first.getDay() + 7) % 7) + (n - 1) * 7;
      return new Date(year, monthIndex, day);
    }
    const lastDay = new Date(year, monthIndex + 1, 0);
    const day = lastDay.getDate() - ((lastDay.getDay() - weekday + 7) % 7);
    return new Date(year, monthIndex, day);
  }
  function observedHolidayDate(date) {
    const dow = date.getDay();
    const result = new Date(date);
    if (dow === 6) result.setDate(result.getDate() - 1);
    else if (dow === 0) result.setDate(result.getDate() + 1);
    return result;
  }
  function getCoreHolidaysForYear(year) {
    return [
      observedHolidayDate(new Date(year, 0, 1)),   // New Year's Day
      nthWeekdayOfMonth(year, 4, 1, -1),           // Memorial Day - last Mon of May
      observedHolidayDate(new Date(year, 6, 4)),   // July 4th
      nthWeekdayOfMonth(year, 8, 1, 1),            // Labor Day - 1st Mon of Sep
      nthWeekdayOfMonth(year, 10, 4, 4),           // Thanksgiving - 4th Thu of Nov
      observedHolidayDate(new Date(year, 11, 25)), // Christmas
    ];
  }
  function buildHolidaySet(year) {
    const dates = [...getCoreHolidaysForYear(year), ...getCoreHolidaysForYear(year + 1)];
    return new Set(dates.map(ymdKey));
  }
  function addBusinessDaysHol(date, days, holidaySet) {
    const result = new Date(date);
    let added = 0;
    while (added < days) {
      result.setDate(result.getDate() + 1);
      const dow = result.getDay();
      const isWeekend = dow === 0 || dow === 6;
      const isHoliday = holidaySet && holidaySet.has(ymdKey(result));
      if (!isWeekend && !isHoliday) added++;
    }
    return result;
  }

  // Extracts JS day-of-week indices (0=Sun..6=Sat) from a Set
  // Schedule string like "Every Monday and Friday". Returns null -
  // meaning DO NOT force - for "Never Schedule..." (hauler
  // self-manages) and for anything mentioning "by Hauler" (hybrids:
  // the hauler-owned days are theirs, so those boxes stay purely
  // reading-driven per explicit design decision, 2026-07-06).
  function parseSetScheduleDays(text) {
    const t = String(text || '').trim();
    if (!t) return null;
    if (/never\s+schedule/i.test(t)) return null;
    if (/by\s+hauler/i.test(t)) return null;
    const names = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const days = [];
    names.forEach(function (name, idx) {
      if (new RegExp('\\b' + name + 's?\\b', 'i').test(t)) days.push(idx);
    });
    return days.length > 0 ? days : null;
  }

  // "NBD" -> 1, "N-BD" -> N+1 - identical semantics to the
  // dashboard's computeSuggestedPickupDate. null for anything else.
  function parseRuleBusinessDays(rule) {
    const normalized = String(rule || '').trim().toUpperCase();
    if (!normalized) return null;
    if (normalized === 'NBD') return 1;
    const m = normalized.match(/^(\d+)-BD$/);
    return m ? parseInt(m[1], 10) + 1 : null;
  }

  // Decides whether TODAY falls inside a box's order window. For each
  // upcoming scheduled pull, the order day is the LATEST business day
  // from which the rule's math still lands on (or before) the pull
  // day; that pull's WINDOW is orderDay..pullDay.
  //
  // v4.7.1 FIX (found live on Box 443, Mon+Fri / 2-BD): coverage is
  // now per-WINDOW, not per-lookback. The old check ("requested
  // within SUPPRESS_DAYS") was structurally too short - a 2-BD window
  // spans up to 6 calendar days, so an order placed on its order day
  // (Tue 6/30 for the Mon 7/6 pull) looked stale by pull day and the
  // box got re-flagged with an impossible "order by <past date>"
  // instruction. Now: the page's Date Pull Requested covers the FIRST
  // upcoming pull whose window contains it - that pull is ordered,
  // skip it, evaluate the next one. One request covers exactly ONE
  // pull (a Mon+Fri box's Friday order never silences the following
  // Monday's). A pull past its order day with NO covering request
  // still flags - you can't order backwards in time, but a missed
  // order is exactly what should be loudest - with late:true so the
  // note reads ORDER OVERDUE instead of "order by <yesterday>".
  // Returns null when nothing is due, else
  // { pullDate, orderDate, ruleLabel, late }.
  function computeSetScheduleDue(boxId, state) {
    try {
      const map = state && state.daysCyclesMap;
      const trig = map ? map[String(boxId)] : null;
      if (!trig || !trig.s) return null;
      const schedDays = parseSetScheduleDays(trig.s);
      if (!schedDays) return null;
      // No rule on file -> order one business day ahead
      // (NBD-equivalent), the safe default per explicit decision.
      const bd = parseRuleBusinessDays(trig.r) !== null ? parseRuleBusinessDays(trig.r) : 1;
      const ruleLabel = trig.r ? String(trig.r).trim() : 'NBD default';
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const holidaySet = buildHolidaySet(today.getFullYear());
      // The page's Date Pull Requested - the one request date this
      // box carries. Normalized to midnight for window comparison.
      let reqTime = null;
      const reqRaw = getDatePullRequested();
      if (reqRaw instanceof Date && !isNaN(reqRaw.getTime())) {
        const r = new Date(reqRaw);
        r.setHours(0, 0, 0, 0);
        reqTime = r.getTime();
      }
      let requestConsumed = false;
      // Scan the next 14 days for scheduled pull days, nearest first.
      for (let offset = 0; offset < 14; offset++) {
        const pullDate = new Date(today);
        pullDate.setDate(pullDate.getDate() + offset);
        if (schedDays.indexOf(pullDate.getDay()) === -1) continue;
        // Latest business day whose rule-computed service date still
        // makes the pull day - step back from the pull date until the
        // forward math fits.
        const orderDate = new Date(pullDate);
        for (let back = 0; back < 30; back++) {
          orderDate.setDate(orderDate.getDate() - 1);
          const dow = orderDate.getDay();
          if (dow === 0 || dow === 6 || holidaySet.has(ymdKey(orderDate))) continue;
          if (addBusinessDaysHol(orderDate, bd, holidaySet).getTime() <= pullDate.getTime()) break;
        }
        // Covered? The request date falls inside THIS pull's window
        // and hasn't already covered an earlier pull.
        if (!requestConsumed && reqTime !== null &&
            reqTime >= orderDate.getTime() && reqTime <= pullDate.getTime()) {
          requestConsumed = true;
          continue; // this pull is ordered - evaluate the next one
        }
        if (today.getTime() >= orderDate.getTime() && today.getTime() <= pullDate.getTime()) {
          return {
            pullDate: pullDate,
            orderDate: orderDate,
            ruleLabel: ruleLabel,
            late: today.getTime() > orderDate.getTime(),
          };
        }
        // Nearest uncovered pull not due yet -> nothing sooner can be.
        if (today.getTime() < orderDate.getTime()) return null;
      }
      return null;
    } catch (e) {
      return null;
    }
  }
  function formatShortDay(d) {
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return names[d.getDay()] + ' ' + String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0');
  }

  // Fetches the per-box Days/Cycle Trigger values from the Google
  // Sheet's "Days & Cycles" tab (col A = BoxId, col D = Days Trigger,
  // col E = Cycle Trigger; "N/A" cells come back as null) via the Apps
  // Script's ?action=days_cycles. Same JSONP pattern and same
  // guarantees as fetchGreenListFromSheet: resolves with a
  // { boxId: { d, c } } map on success or null on ANY failure - never
  // rejects, never stops the scan.
  function fetchDaysCyclesFromSheet() {
    return new Promise((resolve) => {
      const cbName = 'wastenetDaysCycles_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
      const script = document.createElement('script');
      let settled = false;
      const finish = (map) => {
        if (settled) return;
        settled = true;
        try { delete window[cbName]; } catch (e) {}
        if (script.parentNode) script.parentNode.removeChild(script);
        clearTimeout(timeoutId);
        resolve(map);
      };
      window[cbName] = (data) => {
        if (data && data.ok && data.map && typeof data.map === 'object') {
          finish(data.map);
        } else {
          finish(null);
        }
      };
      const timeoutId = setTimeout(() => finish(null), 10000);
      script.onerror = () => finish(null);
      script.src = GOOGLE_SHEETS_WEBHOOK_URL + '?action=days_cycles&callback=' + cbName;
      document.head.appendChild(script);
    });
  }

  function getDatePullRequested() {
    const label = [...document.querySelectorAll('*')].find(
      (el) => el.children.length === 0 && /Date Pull Requested/i.test(el.textContent || '')
    );
    if (!label) return null;

    const container = label.closest('table') || label.parentElement || document;
    const candidateInputs = container.querySelectorAll('input[type="text"], input:not([type])');
    const datePattern = /\d{1,4}[/-]\d{1,2}[/-]\d{1,4}/;
    let input = null;
    for (const candidate of candidateInputs) {
      if (candidate.value && datePattern.test(candidate.value)) {
        input = candidate;
        break;
      }
    }
    if (!input || !input.value) return null;

    const raw = input.value.trim();
    const parsed = new Date(raw);
    if (isNaN(parsed.getTime())) return null;
    return parsed;
  }

  function isDateWithinDays(date, maxDays) {
    if (!date) return false;
    const now = new Date();
    const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const nowDateOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diffMs = nowDateOnly.getTime() - dateOnly.getTime();
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
    return diffDays >= 0 && diffDays <= maxDays;
  }

  function wasServiceRequestedRecently(maxDays) {
    return isDateWithinDays(getDatePullRequested(), maxDays);
  }

  function findShowCheckbox(labelSubstring) {
    const trendGraph1Heading = [...document.querySelectorAll('*')].find(
      (el) => el.children.length === 0 && /Trend Graph #1/i.test(el.textContent || '')
    );
    let scope = trendGraph1Heading ? trendGraph1Heading.closest('table') : null;

    function search(root) {
      const checkboxes = root.querySelectorAll('input[type="checkbox"]');
      for (const cb of checkboxes) {
        const nearbyText =
          (cb.nextSibling && cb.nextSibling.textContent) ||
          (cb.parentElement && cb.parentElement.textContent) ||
          '';
        if (nearbyText.indexOf(labelSubstring) !== -1) return cb;
      }
      return null;
    }

    if (scope) {
      const found = search(scope);
      if (found) return found;
    }
    return search(document);
  }

  function findNextShowModeAction(mode) {
    const aboxCb = findShowCheckbox('Show ABox');
    const a1Cb = findShowCheckbox('Show A1');
    const a3Cb = findShowCheckbox('Show A3');

    const wantABox = mode === 'ABox';
    const wantA3 = mode === 'A3';

    if (a1Cb && a1Cb.checked) return a1Cb;
    if (aboxCb && aboxCb.checked !== wantABox) return aboxCb;
    if (a3Cb && a3Cb.checked !== wantA3) return a3Cb;
    return null;
  }

  function getBoxRows() {
    const anyBtn = [...document.querySelectorAll('input[type="button"]')].find((b) =>
      /__doPostBack\('BoxGrid1\$gvBox','Select\$/.test(b.getAttribute('onclick') || '')
    );
    if (!anyBtn) throw new Error('Could not find the box grid Select buttons.');
    const table = anyBtn.closest('table');
    if (!table) throw new Error('Could not find the grid table.');

    const rows = [...table.querySelectorAll('tbody > tr')].filter((tr) => tr.querySelector('td'));
    const result = [];
    rows.forEach((tr) => {
      const cells = tr.querySelectorAll('td');
      if (cells.length < 4) return;
      const selectBtn = cells[0].querySelector('input[type="button"]');
      if (!selectBtn) return;
      const onclick = selectBtn.getAttribute('onclick') || '';
      const m = onclick.match(/Select\$(\d+)/);
      if (!m) return;
      result.push({
        rowIndex: parseInt(m[1], 10),
        boxId: cells[1].textContent.trim(),
        cell: cells[2].textContent.trim(),
        description: cells[3].textContent.trim(),
      });
    });
    return result;
  }

  function selectRow(rowIndex) {
    const anyBtn = [...document.querySelectorAll('input[type="button"]')].find((b) =>
      /__doPostBack\('BoxGrid1\$gvBox','Select\$/.test(b.getAttribute('onclick') || '')
    );
    if (!anyBtn) throw new Error('Could not find the box grid.');
    const table = anyBtn.closest('table');
    const targetPattern = new RegExp("Select\\$" + rowIndex + "(?=[^0-9]|$)");
    const buttons = table.querySelectorAll('input[type="button"]');
    let target = null;
    for (const btn of buttons) {
      const onclick = btn.getAttribute('onclick') || '';
      if (targetPattern.test(onclick)) {
        target = btn;
        break;
      }
    }
    if (!target) throw new Error('Could not find the Select button for row ' + rowIndex + '.');
    target.click();
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }
  function saveState(state) {
    state.lastActivityAt = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
  function clearState() {
    localStorage.removeItem(STORAGE_KEY);
  }

  function isStopped() {
    const fresh = loadState();
    return !fresh || fresh.done === true;
  }

  function analyzeTriggerCrossing(imgEl, showMode, triggerChoice, trigger1, trigger2) {
    const canvas = document.createElement('canvas');
    canvas.width = imgEl.naturalWidth || imgEl.width;
    canvas.height = imgEl.naturalHeight || imgEl.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgEl, 0, 0, canvas.width, canvas.height);

    const w = canvas.width;
    const h = canvas.height;
    const imgData = ctx.getImageData(0, 0, w, h).data;

    function px(x, y) {
      const i = (y * w + x) * 4;
      return [imgData[i], imgData[i + 1], imgData[i + 2]];
    }
    function colorDist(c1, c2) {
      return Math.abs(c1[0] - c2[0]) + Math.abs(c1[1] - c2[1]) + Math.abs(c1[2] - c2[2]);
    }

    const left = Math.round(w * 0.12);
    const right = Math.round(w * 0.95);
    const top = Math.round(h * 0.05);
    const bottom = Math.round(h * 0.92);

    const gridRows = [];
    for (let y = top; y <= bottom; y++) {
      let count = 0;
      for (let x = left + 20; x <= right - 20; x += 3) {
        const c = px(x, y);
        const isGreyish = Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]) < 12;
        const isDarkEnough = c[0] < 180;
        if (isGreyish && isDarkEnough) count++;
      }
      if (count > ((right - left - 40) / 3) * 0.55) gridRows.push(y);
    }
    const collapsedGrid = [];
    let cluster = [];
    for (let i = 0; i < gridRows.length; i++) {
      if (cluster.length === 0 || gridRows[i] - cluster[cluster.length - 1] <= 2) {
        cluster.push(gridRows[i]);
      } else {
        collapsedGrid.push(Math.round(cluster.reduce((a, b) => a + b, 0) / cluster.length));
        cluster = [gridRows[i]];
      }
    }
    if (cluster.length) collapsedGrid.push(Math.round(cluster.reduce((a, b) => a + b, 0) / cluster.length));
    if (collapsedGrid.length < 2) throw new Error('Could not detect chart gridlines.');

    const gaps = [];
    for (let i = 1; i < collapsedGrid.length; i++) {
      gaps.push(collapsedGrid[i] - collapsedGrid[i - 1]);
    }
    const sortedGaps = gaps.slice().sort((a, b) => a - b);
    const medianGap = sortedGaps.length
      ? sortedGaps[Math.floor(sortedGaps.length / 2)]
      : (collapsedGrid[collapsedGrid.length - 1] - collapsedGrid[0]) / 5;

    const EXPECTED_GRIDLINES = 6;
    const EXPECTED_GAPS = EXPECTED_GRIDLINES - 1;

    let topRow, bottomRow;
    if (collapsedGrid.length >= EXPECTED_GRIDLINES) {
      topRow = collapsedGrid[0];
      bottomRow = collapsedGrid[collapsedGrid.length - 1];
    } else {
      bottomRow = collapsedGrid[collapsedGrid.length - 1];
      topRow = bottomRow - medianGap * EXPECTED_GAPS;
    }

    function pctToRow(pct) {
      return topRow + ((100 - pct) / 100) * (bottomRow - topRow);
    }

    const emptyMarkerColor = [255, 0, 0];
    const plotWidth = right - left;
    const redPoints = [];
    for (let x = left; x <= right; x++) {
      for (let y = top; y <= bottom; y++) {
        const c = px(x, y);
        if (colorDist(c, emptyMarkerColor) < 60) {
          redPoints.push([x, y]);
        }
      }
    }

    const pointSet = new Set(redPoints.map(([x, y]) => x + ',' + y));
    const visited = new Set();
    const clusters = [];
    const PROXIMITY = 3;
    for (const point of redPoints) {
      const key = point[0] + ',' + point[1];
      if (visited.has(key)) continue;
      const cluster = [];
      const queue = [point];
      visited.add(key);
      while (queue.length) {
        const [cx, cy] = queue.pop();
        cluster.push([cx, cy]);
        for (let dx = -PROXIMITY; dx <= PROXIMITY; dx++) {
          for (let dy = -PROXIMITY; dy <= PROXIMITY; dy++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx, ny = cy + dy;
            const nkey = nx + ',' + ny;
            if (pointSet.has(nkey) && !visited.has(nkey)) {
              visited.add(nkey);
              queue.push([nx, ny]);
            }
          }
        }
      }
      clusters.push(cluster);
    }

    let hasEmptyMarker = false;
    for (const cluster of clusters) {
      const xs = cluster.map((p) => p[0]);
      const ys = cluster.map((p) => p[1]);
      const colSpan = Math.max(...xs) - Math.min(...xs);
      const rowSpan = Math.max(...ys) - Math.min(...ys);
      if (colSpan < plotWidth * 0.25 && rowSpan > 5) {
        hasEmptyMarker = true;
        break;
      }
    }

    const dataLineColor = showMode === 'A3' ? [0, 128, 0] : [72, 145, 241];

    const trigger1Row = trigger1 !== null ? pctToRow(trigger1) : null;
    const trigger2Row = trigger2 !== null ? pctToRow(trigger2) : null;
    const activeTriggerRow = triggerChoice === 'trigger2' ? trigger2Row : trigger1Row;
    const activeTriggerValue = triggerChoice === 'trigger2' ? trigger2 : trigger1;

    if (activeTriggerRow === null) {
      throw new Error((triggerChoice === 'trigger2' ? 'Trigger2' : 'Trigger1') + ' value not available on this box - cannot evaluate.');
    }

    const excludedRows = new Set();
    for (const r of [trigger1Row, trigger2Row]) {
      if (r !== null) {
        const rounded = Math.round(r);
        for (let dy = -8; dy <= 8; dy++) excludedRows.add(rounded + dy);
      }
    }

    const searchTop = Math.max(top, Math.round(topRow) - 2);
    const searchBottom = Math.min(bottom, Math.round(bottomRow) + 2);

    const colHits = {};
    for (let x = left; x <= right; x++) {
      for (let y = searchTop; y <= searchBottom; y++) {
        if (excludedRows.has(y)) continue;
        const c = px(x, y);
        if (colorDist(c, dataLineColor) < 90) {
          if (!colHits[x]) colHits[x] = [];
          colHits[x].push(y);
        }
      }
    }

    const matchedCols = Object.keys(colHits).map(Number).sort((a, b) => a - b);
    if (matchedCols.length === 0) {
      throw new Error('Could not detect the data line color (' + showMode + ' mode) on the chart.');
    }

    const COLUMN_GAP_TOLERANCE = 10;
    const runs = [];
    let currentRun = [matchedCols[0]];
    for (let i = 1; i < matchedCols.length; i++) {
      if (matchedCols[i] - currentRun[currentRun.length - 1] <= COLUMN_GAP_TOLERANCE) {
        currentRun.push(matchedCols[i]);
      } else {
        runs.push(currentRun);
        currentRun = [matchedCols[i]];
      }
    }
    runs.push(currentRun);

    const longestRun = runs.reduce((best, r) => (r.length > best.length ? r : best), runs[0]);

    let maxPct = 0;
    let crossesTrigger = false;

    for (const x of longestRun) {
      for (const y of colHits[x]) {
        const pct = 100 + ((y - topRow) / (bottomRow - topRow)) * (0 - 100);
        if (pct > maxPct) maxPct = pct;
      }
    }

    const pixelsPerCycle = (longestRun[longestRun.length - 1] - longestRun[0]) / SCAN_CYCLES;
    const SPIKE_MAX_CYCLES = 3;
    const spikeMaxPixelWidth = pixelsPerCycle * SPIKE_MAX_CYCLES;

    const aboveTriggerByCol = longestRun.map((x) => colHits[x].some((y) => y <= activeTriggerRow));
    const aboveRuns = [];
    let runStart = null;
    for (let i = 0; i < aboveTriggerByCol.length; i++) {
      if (aboveTriggerByCol[i]) {
        if (runStart === null) runStart = i;
      } else if (runStart !== null) {
        aboveRuns.push({ startIdx: runStart, endIdx: i - 1 });
        runStart = null;
      }
    }
    if (runStart !== null) {
      aboveRuns.push({ startIdx: runStart, endIdx: aboveTriggerByCol.length - 1 });
    }

    for (const run of aboveRuns) {
      const isAtNewestEdge = run.endIdx === aboveTriggerByCol.length - 1;
      const widthPixels = longestRun[run.endIdx] - longestRun[run.startIdx];
      const isLongEnough = widthPixels >= spikeMaxPixelWidth;
      if (isAtNewestEdge || isLongEnough) {
        crossesTrigger = true;
        break;
      }
    }

    if (maxPct > 105 || maxPct < -5) {
      throw new Error('Calibration produced an out-of-range reading (' + Math.round(maxPct * 10) / 10 + '%) - likely a misdetected gridline.');
    }

    return {
      maxPct: Math.round(maxPct * 10) / 10,
      crossesTrigger,
      activeTriggerValue,
      hasEmptyMarker,
    };
  }

  function csvEscape(value) {
    const str = String(value ?? '');
    return str.includes(',') || str.includes('"') || str.includes('\n')
      ? '"' + str.replace(/"/g, '""') + '"'
      : str;
  }

  function sortResultsByServicePriority(results) {
    const sorted = results.slice();
    sorted.sort((a, b) => {
      const textA = a.serviceNeeded === true ? 'YES' : a.serviceNeeded === false ? 'NO' : '';
      const textB = b.serviceNeeded === true ? 'YES' : b.serviceNeeded === false ? 'NO' : '';
      if (textA !== textB) return textB.localeCompare(textA);
      const descA = a.description || '';
      const descB = b.description || '';
      return descA.localeCompare(descB);
    });
    return sorted;
  }

  function sendToGoogleSheets(sortedResults) {
    if (!GOOGLE_SHEETS_WEBHOOK_URL) {
      log('Google Sheets webhook not configured - results only printed to console.');
      return;
    }

    const payload = {
      results: sortedResults.map((r) => ({
        boxId: r.boxId,
        cell: r.cell,
        description: r.description,
        showMode: r.showMode,
        maxPctInZone: r.maxPct,
        trigger1Pct: r.trigger1,
        trigger2Pct: r.trigger2,
        triggerUsed: r.triggerUsed,
        crossedTrigger: r.crossedTrigger === null || r.crossedTrigger === undefined ? '' : (r.crossedTrigger ? 'YES' : 'NO'),
        datePullRequested: r.datePullRequested || '',
        serviceNeeded: r.serviceNeeded,
        scheduledPickup: r.scheduledPickup === true,
        scheduledDate: r.scheduledDate || '',
        advisory: r.advisory || '',
        lastCycleHours: r.lastCycleHours === null || r.lastCycleHours === undefined ? '' : r.lastCycleHours,
        notes: r.notes || '',
        // v4.10: appended at END (position-stability discipline). Apps
        // Script can ignore these until Stage 2 adds matching columns.
        monitorNotReporting: r.monitorNotReporting === true,
        monitorReasonCode: r.monitorReasonCode || '',
        monitorPrevSentinel: r.monitorPrevSentinel === true,
      })),
    };

    log('Sending results to Google Sheets...');
    fetch(GOOGLE_SHEETS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload),
    })
      .then((resp) => resp.text())
      .then((text) => {
        console.log('[Box Service Check v2] Google Sheets response:', text);
        try {
          const parsed = JSON.parse(text);
          if (parsed.ok) {
            if (GOOGLE_SHEET_VIEW_URL) {
              logHtml(
                '✅ Done! Results are in the <a href="' + GOOGLE_SHEET_VIEW_URL + '" target="_blank" rel="noopener" style="color:#1a73e8; font-weight:600; text-decoration:underline;">Google Sheet</a> (tab "' + parsed.sheetName + '").'
              );
            } else {
              log('✅ Done! Results are in the Google Sheet (tab "' + parsed.sheetName + '").');
            }
            flashPanel('#27ae60');
          } else {
            log('⚠️ Google Sheets reported an error: ' + parsed.error);
            flashPanel('#c0392b');
          }
        } catch (e) {
          log('Sent to Google Sheets, but got an unexpected response.');
        }
      })
      .catch((err) => {
        log('⚠️ Could not reach Google Sheets (' + err.message + ').');
        flashPanel('#c0392b');
      });
  }

  function finishScan(results) {
    const sortedResults = sortResultsByServicePriority(results);

    const headers = ['BoxId', 'Cell', 'Description', 'ShowMode', 'MaxPct', 'Trigger1Pct', 'Trigger2Pct', 'TriggerUsed', 'CrossedTrigger', 'DatePullRequested', 'ServiceNeeded', 'Advisory', 'LastCycleHours', 'Notes', 'MonitorNotReporting', 'MonitorReasonCode', 'MonitorPrevSentinel'];
    const lines = [headers.join(',')];
    sortedResults.forEach((r) => {
      lines.push([
        r.boxId,
        csvEscape(r.cell),
        csvEscape(r.description),
        r.showMode || '',
        r.maxPct ?? '',
        r.trigger1 ?? '',
        r.trigger2 ?? '',
        r.triggerUsed || '',
        r.crossedTrigger === null || r.crossedTrigger === undefined ? '' : (r.crossedTrigger ? 'YES' : 'NO'),
        csvEscape(r.datePullRequested || ''),
        r.serviceNeeded === null ? '' : (r.serviceNeeded ? 'YES' : 'NO'),
        csvEscape(r.advisory || ''),
        r.lastCycleHours ?? '',
        csvEscape(r.notes || ''),
        r.monitorNotReporting === true ? 'YES' : 'NO',
        csvEscape(r.monitorReasonCode || ''),
        r.monitorPrevSentinel === true ? 'YES' : 'NO',
      ].join(','));
    });
    const csvText = lines.join('\n');

    console.log('%c----- COPY EVERYTHING BELOW THIS LINE -----', 'font-weight:bold; color:#2980b9;');
    console.log(csvText);
    console.log('%c----- COPY EVERYTHING ABOVE THIS LINE -----', 'font-weight:bold; color:#2980b9;');

    // v4.10: end-of-run MONITOR-NOT-REPORTING summary. Prints to cron.log
    // so the count is visible after a full scan WITHOUT any sheet change -
    // this is the whole point of the Stage-1 detection pass. The split
    // (latest-only vs last-two-agree) decides the strictness rule before
    // the Stage-2 "Monitor Down" bucket is built.
    const mnr = sortedResults.filter((r) => r.monitorNotReporting === true);
    const bothTwo = mnr.filter((r) => r.monitorPrevSentinel === true);
    log('===== MONITOR NOT REPORTING: ' + mnr.length + ' of ' + sortedResults.length
      + ' box(es) hit the 75000 sentinel on the latest completed entry; '
      + bothTwo.length + ' of those also have the previous entry as sentinel (last-two-agree). =====');
    if (mnr.length) {
      log('  Sentinel boxes: ' + mnr.map((r) => r.boxId
        + (r.monitorReasonCode ? '(r' + r.monitorReasonCode + ')' : '')
        + (r.monitorPrevSentinel ? '*' : '')).join(', ')
        + '   (* = last two entries agree; rNN = stacked reason code)');
    }

    // Targeted/diagnostic run (runner --box): the flag rode through the
    // whole scan in the persisted state, so read it here and DO NOT write
    // the sheet - the console/CSV output above is the whole deliverable,
    // and today's real tab is left untouched.
    const st = loadState();
    if (st && st.noUpload === true) {
      log('TARGETED/diagnostic run - skipping Google Sheets upload (today\'s tab left untouched).');
      return;
    }

    sendToGoogleSheets(sortedResults);
  }

  /* ================= v4.5: AUTO-RUN / AUTO-LOGIN ================= */

  const AUTORUN_CFG_KEY = 'wastenetAutoRunConfig_v1';
  const AUTORUN_LAST_KEY = 'wastenetAutoRunLastDate_v1';
  const CREDS_KEY = 'wastenetCesCreds_v1';
  const LOGIN_ATTEMPT_KEY = 'wastenetLoginAttemptAt_v1';
  const AUTORUN_WINDOW_END_HOUR = 12; // missed alarms only fire until noon
  const KEEPALIVE_MS = 15 * 60 * 1000;

  function loadAutoRunConfig() {
    try {
      return JSON.parse(localStorage.getItem(AUTORUN_CFG_KEY) || 'null') || { enabled: false, time: '05:55' };
    } catch (e) { return { enabled: false, time: '05:55' }; }
  }
  function saveAutoRunConfig(cfg) { localStorage.setItem(AUTORUN_CFG_KEY, JSON.stringify(cfg)); }

  function loadCreds() {
    try { return JSON.parse(localStorage.getItem(CREDS_KEY) || 'null'); } catch (e) { return null; }
  }

  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // The CES login form renders at the Monitor.aspx URL itself when the
  // session has expired. Detection is structural: a password field
  // present and no box grid.
  function isLoginPage() {
    return !!document.querySelector('input[type="password"]') &&
      ![...document.querySelectorAll('input[type="button"]')].some((b) =>
        /__doPostBack\('BoxGrid1\$gvBox','Select\$/.test(b.getAttribute('onclick') || ''));
  }

  // Fills saved credentials into the login form and submits. All
  // fields found structurally (no guessed IDs): the ONLY password
  // input, the nearest text input before it (User Name), the only
  // checkbox (Remember me), and the submit whose value reads "Log
  // In". Rate-limited to one attempt per minute so bad credentials
  // can't hammer the portal - and a wrong-password loop parks itself
  // rather than retrying forever.
  function attemptAutoLogin() {
    const creds = loadCreds();
    if (!creds || !creds.u || !creds.p) {
      showLoginNotice('No saved login. Open Monitor.aspx while logged in and save credentials in the scanner panel (Auto-Run section).');
      return;
    }
    const lastAttempt = parseInt(localStorage.getItem(LOGIN_ATTEMPT_KEY) || '0', 10);
    if (Date.now() - lastAttempt < 60000) {
      showLoginNotice('Login attempted less than a minute ago - waiting before retrying (wrong password protection).');
      return;
    }
    const pwd = document.querySelector('input[type="password"]');
    if (!pwd) return;
    const textInputs = [...document.querySelectorAll('input[type="text"]')];
    let userInput = null;
    for (const t of textInputs) {
      // the User Name field precedes the password field in DOM order
      if (t.compareDocumentPosition(pwd) & Node.DOCUMENT_POSITION_FOLLOWING) userInput = t;
    }
    const remember = document.querySelector('input[type="checkbox"]');
    const loginBtn = [...document.querySelectorAll('input[type="submit"], input[type="button"], button')]
      .find((b) => /log\s*in/i.test(b.value || b.textContent || ''));
    if (!userInput || !loginBtn) {
      showLoginNotice('Could not locate the login form fields - login page layout may have changed.');
      return;
    }
    localStorage.setItem(LOGIN_ATTEMPT_KEY, String(Date.now()));
    userInput.value = creds.u;
    pwd.value = creds.p;
    if (remember && !remember.checked) remember.click();
    showLoginNotice('Logging in as ' + creds.u + '...');
    loginBtn.click();
  }

  function showLoginNotice(msg) {
    let el = document.getElementById('wn-autologin-notice');
    if (!el) {
      el = document.createElement('div');
      el.id = 'wn-autologin-notice';
      el.style.cssText = 'position:fixed;top:16px;right:16px;z-index:999999;background:#f5f7fa;border:1px solid #c7d0d9;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.25);font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:12px;color:#1f2d3d;padding:10px 12px;max-width:280px;';
      document.body.appendChild(el);
    }
    el.textContent = 'WasteNet Scanner: ' + msg;
    console.log('[AutoLogin] ' + msg);
  }

  function scanIsActive() {
    const s = loadState();
    return !!(s && !s.done);
  }

  function updateAutoRunStatusLine() {
    const el = document.getElementById('service-check-autorun-status');
    if (!el) return;
    const cfg = loadAutoRunConfig();
    if (!cfg.enabled) { el.textContent = 'Auto-run is OFF.'; return; }
    const last = localStorage.getItem(AUTORUN_LAST_KEY) || '';
    const ranToday = last === todayStr();
    el.textContent = 'Auto-run ON, daily at ' + cfg.time +
      (ranToday ? ' - ran today \u2713' : ' - next run: ' + (isPastWindow(cfg.time) ? 'tomorrow' : 'today') + ' ' + cfg.time) +
      (loadCreds() ? ' | login saved \u2713' : ' | \u26A0 NO LOGIN SAVED');
  }

  function isPastWindow(timeStr) {
    const now = new Date();
    return now.getHours() >= AUTORUN_WINDOW_END_HOUR ||
      (now.getHours() * 60 + now.getMinutes()) > (AUTORUN_WINDOW_END_HOUR * 60);
  }

  // The alarm clock: every 30s, check whether an auto-run is due.
  // Fires when: enabled, no scan active, none run today, and the
  // current time is inside [target, noon). Sets the once-per-day
  // guard BEFORE starting, so a crash mid-scan can't cause a
  // same-day re-fire loop (the resumable state machine handles the
  // crash recovery instead).
  function startAutoRunTicker() {
    setInterval(() => {
      updateAutoRunStatusLine();
      const cfg = loadAutoRunConfig();
      if (!cfg.enabled || scanIsActive()) return;
      if (localStorage.getItem(AUTORUN_LAST_KEY) === todayStr()) return;
      const [hh, mm] = (cfg.time || '05:55').split(':').map((x) => parseInt(x, 10));
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const targetMin = hh * 60 + mm;
      const windowEnd = AUTORUN_WINDOW_END_HOUR * 60;
      if (nowMin >= targetMin && nowMin < windowEnd) {
        localStorage.setItem(AUTORUN_LAST_KEY, todayStr());
        log('AUTO-RUN: starting the scheduled daily scan (' + cfg.time + ').');
        startNewScan();
      }
    }, 30000);
  }

  // Keep-alive: reload every 15 minutes while idle so the session and
  // timers stay warm overnight. Skipped mid-scan (never interfere)
  // and skipped while the tab has focus (never yank the page out from
  // under a human).
  function startKeepAlive() {
    setInterval(() => {
      const cfg = loadAutoRunConfig();
      if (!cfg.enabled || scanIsActive() || document.hasFocus()) return;
      location.reload();
    }, KEEPALIVE_MS);
  }

  /* =============== end v4.5 AUTO-RUN / AUTO-LOGIN ================ */

  function buildPanel() {
    if (document.getElementById('service-check-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'service-check-panel';
    panel.style.cssText = `
      position: fixed;
      top: 16px;
      right: 16px;
      width: 280px;
      background: #f5f7fa;
      border: 1px solid #c7d0d9;
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.25);
      font-family: -apple-system, Segoe UI, Arial, sans-serif;
      font-size: 13px;
      color: #1f2d3d;
      z-index: 999999;
      padding: 14px;
    `;
    const triggerChoice = getActiveTriggerChoice();
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const todayName = dayNames[new Date().getDay()];
    panel.innerHTML = `
      <div style="font-size:15px; font-weight:600; margin-bottom:8px;">Box Monitor Scan</div>
      <div style="font-size:12px; margin-bottom:8px; color:#37474f; background:#eef3f7; border-radius:4px; padding:6px 8px;">Today is ${todayName} - comparing against <b>${triggerChoice === 'trigger2' ? 'Trigger2 (blue)' : 'Trigger1 (red)'}</b>.</div>
      <div id="service-check-status" style="font-size:13px; margin-bottom:6px; color:#455a64; min-height:18px;">Ready.</div>
      <div id="service-check-timer" style="font-size:12px; margin-bottom:10px; color:#78909c; min-height:16px;"></div>
      <button id="service-check-run-btn" style="width:100%; padding:12px; font-size:15px; border:none; border-radius:6px; cursor:pointer; margin-bottom:8px; font-weight:700; background:#2980b9; color:white;">▶ Run Service Check</button>
      <button id="service-check-stop-btn" style="width:100%; padding:10px; font-size:13px; border:none; border-radius:6px; cursor:pointer; margin-bottom:0; font-weight:600; background:#c0392b; color:white; display:none;">Stop</button>
      <div style="margin-top:10px; padding-top:8px; border-top:1px solid #dde3e8;">
        <a href="#" id="service-check-test-toggle" style="font-size:11px; color:#90a4ae;">Test mode (admin only)</a>
        <div id="service-check-test-controls" style="display:none; margin-top:6px;">
          <input id="service-check-test-count" type="number" value="5" min="1" max="480" style="width:60px; padding:4px; font-size:12px; margin-right:6px;">
          <button id="service-check-test-run-btn" style="padding:6px 10px; font-size:12px; border:none; border-radius:4px; cursor:pointer; background:#7f8c8d; color:white;">Run test batch</button>
        </div>
      </div>
      <div style="margin-top:10px; padding-top:8px; border-top:1px solid #dde3e8;">
        <div style="font-size:12px; font-weight:700; color:#37474f; margin-bottom:4px;">Auto-Run (daily)</div>
        <div id="service-check-autorun-status" style="font-size:11px; color:#78909c; margin-bottom:6px;"></div>
        <label style="font-size:12px; display:flex; align-items:center; gap:6px; margin-bottom:6px;">
          <input type="checkbox" id="service-check-autorun-enabled"> Enable auto-run at
          <input type="time" id="service-check-autorun-time" value="05:55" style="font-size:12px; padding:2px;">
        </label>
        <a href="#" id="service-check-creds-toggle" style="font-size:11px; color:#90a4ae;">Set/update saved login...</a>
        <div id="service-check-creds-controls" style="display:none; margin-top:6px;">
          <input id="service-check-creds-user" type="text" placeholder="CES user name" autocomplete="off" style="width:100%; box-sizing:border-box; padding:4px; font-size:12px; margin-bottom:4px;">
          <input id="service-check-creds-pass" type="password" placeholder="CES password" autocomplete="off" style="width:100%; box-sizing:border-box; padding:4px; font-size:12px; margin-bottom:4px;">
          <button id="service-check-creds-save" style="padding:6px 10px; font-size:12px; border:none; border-radius:4px; cursor:pointer; background:#2980b9; color:white;">Save login</button>
          <div style="font-size:10.5px; color:#90a4ae; margin-top:4px;">Stored only in this browser on this computer. Used by auto-login when the portal session expires.</div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    document.getElementById('service-check-run-btn').addEventListener('click', () => {
      startNewScan();
    });
    document.getElementById('service-check-stop-btn').addEventListener('click', () => {
      const state = loadState();
      if (state) {
        state.stopRequested = true;
        state.done = true;
        saveState(state);
      }
      stopTimerTick();
      log('Stopped by user.');
      setIdleUI();
      if (state && state.results && state.results.length) finishScan(state.results);
    });
    document.getElementById('service-check-test-toggle').addEventListener('click', (e) => {
      e.preventDefault();
      const controls = document.getElementById('service-check-test-controls');
      controls.style.display = controls.style.display === 'none' ? 'block' : 'none';
    });
    document.getElementById('service-check-test-run-btn').addEventListener('click', () => {
      const countInput = document.getElementById('service-check-test-count');
      const n = parseInt(countInput.value, 10);
      startNewScan(n > 0 ? n : 5);
    });

    // v4.5: Auto-Run controls. Config changes save immediately; the
    // 30-second ticker picks them up on its next pass.
    const cfg = loadAutoRunConfig();
    const enabledBox = document.getElementById('service-check-autorun-enabled');
    const timeBox = document.getElementById('service-check-autorun-time');
    enabledBox.checked = !!cfg.enabled;
    timeBox.value = cfg.time || '05:55';
    enabledBox.addEventListener('change', () => {
      const c = loadAutoRunConfig();
      c.enabled = enabledBox.checked;
      saveAutoRunConfig(c);
      updateAutoRunStatusLine();
      log(c.enabled ? 'Auto-run ENABLED (daily at ' + (c.time || '05:55') + '). Leave this tab open overnight.' : 'Auto-run disabled.');
    });
    timeBox.addEventListener('change', () => {
      const c = loadAutoRunConfig();
      c.time = timeBox.value || '05:55';
      saveAutoRunConfig(c);
      updateAutoRunStatusLine();
    });
    document.getElementById('service-check-creds-toggle').addEventListener('click', (e) => {
      e.preventDefault();
      const controls = document.getElementById('service-check-creds-controls');
      controls.style.display = controls.style.display === 'none' ? 'block' : 'none';
      const saved = loadCreds();
      if (saved && saved.u) document.getElementById('service-check-creds-user').value = saved.u;
    });
    document.getElementById('service-check-creds-save').addEventListener('click', () => {
      const u = document.getElementById('service-check-creds-user').value.trim();
      const p = document.getElementById('service-check-creds-pass').value;
      if (!u || !p) { log('Enter both user name and password before saving.'); return; }
      localStorage.setItem(CREDS_KEY, JSON.stringify({ u: u, p: p }));
      document.getElementById('service-check-creds-pass').value = '';
      document.getElementById('service-check-creds-controls').style.display = 'none';
      localStorage.removeItem(LOGIN_ATTEMPT_KEY); // fresh creds - clear the retry limiter
      updateAutoRunStatusLine();
      log('Login saved for auto-login.');
    });
    updateAutoRunStatusLine();
  }

  function setRunningUI() {
    const runBtn = document.getElementById('service-check-run-btn');
    const stopBtn = document.getElementById('service-check-stop-btn');
    if (runBtn) runBtn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = 'block';
  }
  function setIdleUI() {
    const runBtn = document.getElementById('service-check-run-btn');
    const stopBtn = document.getElementById('service-check-stop-btn');
    if (runBtn) runBtn.style.display = 'block';
    if (stopBtn) stopBtn.style.display = 'none';
  }
  function log(msg) {
    console.log('[Box Service Check v2] ' + msg);
    const el = document.getElementById('service-check-status');
    if (el) el.textContent = msg;
  }
  function logHtml(html) {
    console.log('[Box Service Check v2] ' + html);
    const el = document.getElementById('service-check-status');
    if (el) el.innerHTML = html;
  }

  function formatDuration(ms) {
    if (ms < 0 || !isFinite(ms)) return '--';
    const totalSec = Math.round(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function updateTimerDisplay(state) {
    const el = document.getElementById('service-check-timer');
    if (!el) return;
    if (!state || !state.startedAt) {
      el.textContent = '';
      return;
    }

    const now = Date.now();
    const elapsedMs = now - state.startedAt;
    const completed = state.results.length;
    const total = state.boxList.length;

    if (completed === 0) {
      el.textContent = `Elapsed: ${formatDuration(elapsedMs)} - estimating...`;
      return;
    }

    const avgMsPerBox = elapsedMs / completed;
    const remaining = total - completed;
    const etaMs = avgMsPerBox * remaining;

    el.textContent = `Elapsed: ${formatDuration(elapsedMs)} | Avg: ${Math.round(avgMsPerBox / 1000)}s/box | ETA: ${formatDuration(etaMs)} (${completed}/${total})`;
  }

  let timerTickInterval = null;
  function startTimerTick() {
    stopTimerTick();
    timerTickInterval = setInterval(() => {
      const state = loadState();
      if (state && state.startedAt && !state.done) {
        updateTimerDisplay(state);
      } else {
        stopTimerTick();
      }
    }, 1000);
  }
  function stopTimerTick() {
    if (timerTickInterval) {
      clearInterval(timerTickInterval);
      timerTickInterval = null;
    }
  }

  function flashPanel(color) {
    const panel = document.getElementById('service-check-panel');
    if (!panel) return;
    const original = panel.style.background;
    panel.style.background = color;
    panel.style.transition = 'background 0.3s';
    setTimeout(() => {
      panel.style.background = original || '#f5f7fa';
    }, 2500);
  }

  function waitForChartUpdate(prevSrc, onDone, onTimeout, startedAt) {
    const imgEl = getTrendGraphImg();
    const now = Date.now();
    if (now - startedAt > PER_BOX_TIMEOUT_MS) {
      onTimeout();
      return;
    }
    const current = imgEl ? imgEl.getAttribute('src') : null;

    if (current && current !== prevSrc) {
      const onLoad = () => {
        imgEl.removeEventListener('load', onLoad);
        imgEl.removeEventListener('error', onError);
        requestAnimationFrame(() => onDone(imgEl));
      };
      const onError = () => {
        imgEl.removeEventListener('load', onLoad);
        imgEl.removeEventListener('error', onError);
        onTimeout();
      };
      if (imgEl.complete) {
        requestAnimationFrame(() => onDone(imgEl));
        return;
      }
      imgEl.addEventListener('load', onLoad, { once: true });
      imgEl.addEventListener('error', onError, { once: true });
      return;
    }
    setTimeout(() => waitForChartUpdate(prevSrc, onDone, onTimeout, startedAt), POLL_INTERVAL_MS);
  }

  function currentSrc() {
    const imgEl = getTrendGraphImg();
    return imgEl ? imgEl.getAttribute('src') : null;
  }

  function waitImgReadyThen(fn, state) {
    const imgEl = getTrendGraphImg();
    if (imgEl && !imgEl.complete) {
      const onLoad = () => {
        imgEl.removeEventListener('load', onLoad);
        imgEl.removeEventListener('error', onLoad);
        requestAnimationFrame(() => fn(state));
      };
      imgEl.addEventListener('load', onLoad, { once: true });
      imgEl.addEventListener('error', onLoad, { once: true });
      return true;
    }
    return false;
  }

  function phase1_showMode(state) {
    if (waitImgReadyThen(phase1_showMode, state)) return;
    if (isStopped()) { log('Stopped.'); setIdleUI(); stopTimerTick(); return; }

    const boxId = state.pendingBoxId;
    const wantMode = isA3Box(boxId, state) ? 'A3' : 'ABox';
    state.pendingShowMode = wantMode;
    state.pendingPhase = 'phase1';
    saveState(state);

    let nextCb;
    try {
      nextCb = findNextShowModeAction(wantMode);
    } catch (err) {
      finalizeError(state, err);
      return;
    }

    if (!nextCb) {
      state.showModeAttempts = 0;
      state.pendingPhase = 'phase2';
      saveState(state);
      phase2_setScanCycles(state);
      return;
    }

    state.showModeAttempts = (state.showModeAttempts || 0) + 1;
    if (state.showModeAttempts > 6) {
      finalizeError(state, new Error('Could not converge Show ABox/A3 checkboxes after ' + state.showModeAttempts + ' attempts.'));
      return;
    }
    saveState(state);

    log(`Box ${boxId}: setting Show ${wantMode}...`);
    const srcBefore = currentSrc();
    nextCb.click();
    const startedAt = Date.now();
    waitForChartUpdate(srcBefore, () => phase1_showMode(state), () => phase1_showMode(state), startedAt);
  }

  function phase2_setScanCycles(state) {
    if (waitImgReadyThen(phase2_setScanCycles, state)) return;
    if (isStopped()) { log('Stopped.'); setIdleUI(); stopTimerTick(); return; }

    const boxId = state.pendingBoxId;
    state.pendingPhase = 'phase2';
    saveState(state);

    const srcBefore = currentSrc();
    let changed;
    try {
      changed = setFieldValue('Set No. Cycles', SCAN_CYCLES);
    } catch (err) {
      finalizeError(state, err);
      return;
    }

    if (changed) {
      log(`Box ${boxId}: setting No. Cycles to ${SCAN_CYCLES}...`);
      state.pendingPhase = 'phase3';
      saveState(state);
      const startedAt = Date.now();
      waitForChartUpdate(
        srcBefore,
        () => phase3_analyze(state, false),
        () => phase3_analyze(state, true),
        startedAt
      );
    } else {
      state.pendingPhase = 'phase3';
      saveState(state);
      phase3_analyze(state, false);
    }
  }

  function phase3_analyze(state, chartFreshnessUnverified) {
    if (waitImgReadyThen((s) => phase3_analyze(s, chartFreshnessUnverified), state)) return;
    if (isStopped()) { log('Stopped.'); setIdleUI(); stopTimerTick(); return; }

    const boxId = state.pendingBoxId;
    state.pendingPhase = 'phase3';
    saveState(state);

    const boxEntry = state.boxList.find((b) => b.boxId === boxId);
    const imgEl = getTrendGraphImg();
    const showMode = state.pendingShowMode || (isA3Box(boxId, state) ? 'A3' : 'ABox');
    const triggerChoice = state.triggerChoice;

    // v4.4: compute the advisory once, up front - it applies to every
    // result path out of this phase and reads only already-rendered
    // page elements (no postbacks, no extra load).
    const advisory = buildAdvisoryForCurrentBox(boxId, state);

    // v4.4: closed-day aware threshold replaces the flat 24h rule. A
    // box whose site is closed Sat+Sun legitimately shows 26-70+ hours
    // on Sunday/Monday mornings - that is not a stuck box.
    const lastCycleHours = getLastCycleHours();
    const thresholdInfo = computeLastCycleThreshold();
    const LAST_CYCLE_THRESHOLD_HOURS = thresholdInfo.thresholdHours;
    if (lastCycleHours !== null && lastCycleHours > LAST_CYCLE_THRESHOLD_HOURS) {
      const thresholdNote = thresholdInfo.closedDaysCounted > 0
        ? '>' + LAST_CYCLE_THRESHOLD_HOURS + 'h threshold, extended for ' + thresholdInfo.closedDaysCounted + ' detected closed day(s)'
        : '>' + LAST_CYCLE_THRESHOLD_HOURS + 'h / 1 day' + (thresholdInfo.gridUsable ? '' : ' - flat rule, <4 weeks of cycle-grid history');
      state.pendingResult = {
        boxId: boxEntry ? boxEntry.boxId : boxId,
        cell: boxEntry ? boxEntry.cell : '',
        description: boxEntry ? boxEntry.description : '',
        showMode,
        maxPct: null,
        trigger1: null,
        trigger2: null,
        triggerUsed: triggerChoice === 'trigger2' ? 'Trigger2' : 'Trigger1',
        crossedTrigger: null,
        datePullRequested: '',
        serviceNeeded: true,
        advisory,
        lastCycleHours: lastCycleHours === null ? null : Math.round(lastCycleHours * 10) / 10,
        notes: 'YES (forced): Last Cycle is ' + Math.round(lastCycleHours * 10) / 10 + ' hours (' + thresholdNote + ') - chart not read, this box needs attention regardless of suppression rules.',
      };
      state.pendingPhase = 'phase4';
      saveState(state);
      log(`Box ${boxId}: Last Cycle ${Math.round(lastCycleHours * 10) / 10}h > ${LAST_CYCLE_THRESHOLD_HOURS}h - forcing YES, skipping chart - resetting cycles...`);
      phase4_resetScanCycles(state);
      return;
    }
    if (lastCycleHours !== null && lastCycleHours > 24 && thresholdInfo.closedDaysCounted > 0) {
      log(`Box ${boxId}: Last Cycle ${Math.round(lastCycleHours * 10) / 10}h suppressed by closed-day threshold (${LAST_CYCLE_THRESHOLD_HOURS}h, ${thresholdInfo.closedDaysCounted} closed day(s)) - reading chart normally.`);
    }

    let analysisResult = null;
    let errorMsg = '';
    let trigger1 = null;
    let trigger2 = null;

    try {
      if (chartFreshnessUnverified) {
        throw new Error('Chart freshness could not be confirmed after setting Cycles to ' + SCAN_CYCLES + ' (timed out waiting for the chart to update) - refusing to analyze a possibly-stale image.');
      }
      if (!imgEl) throw new Error('No chart rendered for this box (e.g. Empty/no data).');
      trigger1 = getFieldValue('Set Trigger1 %');
      trigger2 = getFieldValue('Set Trigger2 %');
      analysisResult = analyzeTriggerCrossing(imgEl, showMode, triggerChoice, trigger1, trigger2);
    } catch (err) {
      errorMsg = err && err.message ? err.message : String(err);
    }

    const datePullRequestedRaw = getDatePullRequested();

    const crossedTrigger = analysisResult ? analysisResult.crossesTrigger : false;
    const hasEmptyMarker = analysisResult ? analysisResult.hasEmptyMarker : false;
    let serviceNeeded = crossedTrigger;
    let recentlyRequested = false;
    let suppressionReason = '';
    if (analysisResult) {
      if (serviceNeeded && hasEmptyMarker) {
        serviceNeeded = false;
        recentlyRequested = true;
        suppressionReason = 'chart shows an Empty marker within the current 50-cycle window';
      } else if (serviceNeeded) {
        const pullRequestedRecently = isDateWithinDays(datePullRequestedRaw, SUPPRESS_DAYS);
        recentlyRequested = pullRequestedRecently;
        if (recentlyRequested) {
          serviceNeeded = false;
          suppressionReason = 'pull requested within last ' + SUPPRESS_DAYS + ' days';
        }
      }
    }

    // v4.7: set-schedule forcing - runs AFTER the reading-based
    // decision and OVERRIDES it to YES whenever today is inside the
    // box's order window (order day through pull day). Independent of
    // the chart entirely (an unreadable chart or an Empty marker
    // doesn't matter - the pull is ordered on schedule, not on fill).
    // The ONE thing that clears it is an order actually placed:
    // Date Pull Requested within SUPPRESS_DAYS, checked directly here
    // since the reading-based branch above only checks it when the
    // trigger crossed.
    let schedForcedNote = '';
    const schedDue = computeSetScheduleDue(boxId, state);
    if (schedDue) {
      // Coverage is handled INSIDE computeSetScheduleDue now (v4.7.1)
      // - a request inside this pull's own window already returned
      // null or skipped to the next pull, so anything that reaches
      // here is a genuinely unordered pull. No SUPPRESS_DAYS check:
      // that 3-day lookback was too short for a 2-BD window and
      // caused the Box 443 false re-flag.
      serviceNeeded = true;
      recentlyRequested = false;
      schedForcedNote = schedDue.late
        ? ('YES (set schedule): ' + formatShortDay(schedDue.pullDate)
          + ' pull per Set Schedule - ORDER OVERDUE (was due by '
          + formatShortDay(schedDue.orderDate) + ', ' + schedDue.ruleLabel + ') and no request is on file.')
        : ('YES (set schedule): ' + formatShortDay(schedDue.pullDate)
          + ' pull per Set Schedule - order by ' + formatShortDay(schedDue.orderDate)
          + ' (' + schedDue.ruleLabel + ').');
      log('Box ' + boxId + ': SET SCHEDULE due - pull ' + formatShortDay(schedDue.pullDate)
        + ', order by ' + formatShortDay(schedDue.orderDate) + (schedDue.late ? ' (OVERDUE)' : '') + ' - forcing YES.');
    }

    // v4.9: SCHEDULED-PICKUP detection. If CES shows a pickup already
    // scheduled (Delete-button row in the Last 400 Days table), the box
    // does NOT need action - it's already booked. This OVERRIDES every
    // upstream YES (trigger crossing, set-schedule forcing). We record
    // it as an observed CES fact via scheduledPickup / scheduledDate,
    // kept entirely separate from WasteNet's own Scheduled/Notified/
    // Confirmed workflow tracking (driven by dashboard actions, not the
    // scan).
    let scheduledPickup = false;
    let scheduledDateIso = '';
    const schedInfo = getScheduledPickupInfo();
    if (schedInfo && schedInfo.scheduledDate) {
      scheduledPickup = true;
      scheduledDateIso = schedInfo.scheduledDate.toISOString();
      serviceNeeded = false;
      recentlyRequested = false;
      log('Box ' + boxId + ': CES shows a scheduled pickup for '
        + formatShortDay(schedInfo.scheduledDate) + ' - not action-needed.');
    }

    // v4.10: MONITOR-NOT-REPORTING detection (DETECTION + COUNT ONLY).
    // Read the newest completed Percent Full from the service-history
    // table; when it is the 75000 sentinel (optionally with a stacked
    // reason code), flag the box and capture the reason. Also classify the
    // PREVIOUS completed entry so a --test/full run can split the count as
    // "latest only" vs "last two agree" - that decides the strictness rule
    // later. NOTHING here changes serviceNeeded or bucketing; this pass
    // only surfaces + counts the signal. (getServiceHistoryInfo is a pure
    // DOM read, safe to call again here as getScheduledPickupInfo does.)
    let monitorNotReporting = false;
    let monitorReasonCode = '';
    let monitorPrevSentinel = false;
    const histSentinel = getServiceHistoryInfo();
    if (histSentinel) {
      const cur = classifyMonitorSentinel(histSentinel.lastPercentRaw);
      if (cur.isSentinel) {
        monitorNotReporting = true;
        monitorReasonCode = cur.reasonCode || '';
        monitorPrevSentinel = classifyMonitorSentinel(histSentinel.prevPercentRaw).isSentinel;
        log('Box ' + boxId + ': MONITOR NOT REPORTING (75000 sentinel'
          + (monitorReasonCode ? ', reason ' + monitorReasonCode : '')
          + (monitorPrevSentinel ? ', prev entry also sentinel' : ', prev entry NOT sentinel')
          + ') - fill % is unreliable. [detection only, bucket unchanged]');
      }
    }

    state.pendingResult = {
      boxId: boxEntry ? boxEntry.boxId : boxId,
      cell: boxEntry ? boxEntry.cell : '',
      description: boxEntry ? boxEntry.description : '',
      showMode,
      maxPct: analysisResult ? analysisResult.maxPct : null,
      trigger1,
      trigger2,
      triggerUsed: triggerChoice === 'trigger2' ? 'Trigger2' : 'Trigger1',
      crossedTrigger: analysisResult ? crossedTrigger : null,
      datePullRequested: datePullRequestedRaw ? datePullRequestedRaw.toISOString() : '',
      serviceNeeded,
      scheduledPickup,
      scheduledDate: scheduledDateIso,
      monitorNotReporting,
      monitorReasonCode,
      monitorPrevSentinel,
      advisory,
      lastCycleHours: lastCycleHours === null ? null : Math.round(lastCycleHours * 10) / 10,
      notes: (scheduledPickup ? 'SCHEDULED: CES shows a pickup scheduled for '
          + formatShortDay(schedInfo.scheduledDate) + ' - not action-needed. '
          : '')
        + (schedForcedNote ? schedForcedNote + ' ' : '')
        + (errorMsg
        ? (schedForcedNote ? 'Chart unreadable: ' : 'NO (chart unreadable): ') + errorMsg
        : (recentlyRequested ? 'Suppressed: ' + suppressionReason + '.' : ''))
        + (lastCycleHours !== null && lastCycleHours > 24 && thresholdInfo.closedDaysCounted > 0
          ? ((errorMsg || recentlyRequested) ? ' ' : '')
            + 'Last Cycle ' + Math.round(lastCycleHours * 10) / 10 + 'h within closed-day threshold ('
            + LAST_CYCLE_THRESHOLD_HOURS + 'h, ' + thresholdInfo.closedDaysCounted + ' closed day(s)).'
          : ''),
    };
    state.pendingPhase = 'phase4';
    saveState(state);

    log(`Box ${boxId}: max=${analysisResult ? analysisResult.maxPct + '%' : 'n/a'} svc=${serviceNeeded}${recentlyRequested ? ' (recent)' : ''} - resetting cycles...`);
    phase4_resetScanCycles(state);
  }

  function phase4_resetScanCycles(state) {
    if (waitImgReadyThen(phase4_resetScanCycles, state)) return;

    const boxId = state.pendingBoxId;
    state.pendingPhase = 'phase4';
    saveState(state);

    const srcBefore = currentSrc();
    let changed;
    try {
      changed = setFieldValue('Set No. Cycles', RESET_CYCLES);
    } catch (err) {
      if (state.pendingResult) {
        state.pendingResult.notes = (state.pendingResult.notes ? state.pendingResult.notes + ' ' : '') +
          'Could not reset cycles to ' + RESET_CYCLES + ': ' + (err && err.message ? err.message : String(err));
      }
      finalizeResult(state);
      return;
    }

    if (changed) {
      state.pendingPhase = 'done';
      saveState(state);
      const startedAt = Date.now();
      waitForChartUpdate(srcBefore, () => finalizeResult(state), () => finalizeResult(state), startedAt);
    } else {
      finalizeResult(state);
    }
  }

  function finalizeError(state, err) {
    const boxId = state.pendingBoxId;
    const boxEntry = state.boxList.find((b) => b.boxId === boxId);
    state.pendingResult = {
      boxId: boxEntry ? boxEntry.boxId : boxId,
      cell: boxEntry ? boxEntry.cell : '',
      description: boxEntry ? boxEntry.description : '',
      showMode: state.pendingShowMode || '',
      maxPct: null,
      trigger1: null,
      trigger2: null,
      triggerUsed: state.triggerChoice === 'trigger2' ? 'Trigger2' : 'Trigger1',
      crossedTrigger: null,
      datePullRequested: '',
      serviceNeeded: null,
      advisory: '',
      lastCycleHours: null,
      notes: err && err.message ? err.message : String(err),
    };
    saveState(state);
    finalizeResult(state);
  }

  function finalizeResult(state) {
    state.results.push(state.pendingResult);
    log(`(${state.results.length}/${state.boxList.length}) Box ${state.pendingResult.boxId} done: svc=${state.pendingResult.serviceNeeded}`);
    // AUTO-VERBOSE on small runs (targeted --box or a small --test batch):
    // dump the key decision fields so you can see WHY the scanner decided
    // what it did - no separate flag. Threshold kept small so full scans
    // stay terse. Runs BEFORE pendingResult is cleared below.
    if (state.boxList && state.boxList.length <= 10 && state.pendingResult) {
      const r = state.pendingResult;
      log('  [detail] Box ' + r.boxId + ': ' + JSON.stringify({
        serviceNeeded: r.serviceNeeded,
        maxPct: r.maxPct,
        trigger1: r.trigger1, trigger2: r.trigger2, triggerUsed: r.triggerUsed,
        crossedTrigger: r.crossedTrigger,
        lastCycleHours: r.lastCycleHours,
        scheduledPickup: r.scheduledPickup, scheduledDate: r.scheduledDate,
        monitorNotReporting: r.monitorNotReporting,
        monitorReasonCode: r.monitorReasonCode,
        monitorPrevSentinel: r.monitorPrevSentinel,
        advisory: r.advisory,
        notes: r.notes,
      }));
    }
    state.pendingBoxId = null;
    state.pendingShowMode = null;
    state.pendingPhase = null;
    state.pendingResult = null;
    saveState(state);
    updateTimerDisplay(state);
    advanceToNextBox(state);
  }

  function advanceToNextBox(state) {
    if (isStopped() || state.stopRequested) {
      state.done = true;
      saveState(state);
      stopTimerTick();
      updateTimerDisplay(state);
      log(`Stopped after ${state.results.length} / ${state.boxList.length}.`);
      setIdleUI();
      if (state.results.length) finishScan(state.results);
      return;
    }

    if (state.nextIndex >= state.boxList.length) {
      state.done = true;
      saveState(state);
      stopTimerTick();
      updateTimerDisplay(state);
      setIdleUI();
      finishScan(state.results);
      return;
    }

    const row = state.boxList[state.nextIndex];
    state.nextIndex += 1;

    const prevSrc = currentSrc();

    state.pendingBoxId = row.boxId;
    state.pendingShowMode = null;
    state.pendingPhase = 'phase1';
    state.pendingResult = null;
    state.showModeAttempts = 0;
    saveState(state);

    log(`(${state.results.length + 1}/${state.boxList.length}) Selecting Box ${row.boxId}...`);

    const startedAt = Date.now();
    waitForChartUpdate(
      prevSrc,
      () => phase1_showMode(state),
      () => {
        const fresh = loadState();
        if (fresh && fresh.pendingBoxId === row.boxId) {
          // v4.11: INLINE RETRY. Count timeouts for THIS box (keyed by
          // boxId so moving to a different box naturally resets it). Under
          // the cap, re-select the same box: point nextIndex back at it,
          // clear the pending fields, and re-enter advanceToNextBox - which
          // re-runs selectRow and starts a fresh chart wait. Only after the
          // retries are exhausted do we write the placeholder and move on.
          const priorRetries = (fresh.timeoutRetryBoxId === row.boxId) ? (fresh.timeoutRetryCount || 0) : 0;
          if (priorRetries < MAX_TIMEOUT_RETRIES) {
            fresh.timeoutRetryBoxId = row.boxId;
            fresh.timeoutRetryCount = priorRetries + 1;
            fresh.nextIndex -= 1; // re-point at this same box
            fresh.pendingBoxId = null;
            fresh.pendingShowMode = null;
            fresh.pendingPhase = null;
            fresh.pendingResult = null;
            fresh.showModeAttempts = 0;
            saveState(fresh);
            log(`↻ Box ${row.boxId}: chart didn't update - retry ${fresh.timeoutRetryCount}/${MAX_TIMEOUT_RETRIES}...`);
            advanceToNextBox(fresh);
            return;
          }
          // Retries exhausted - write the placeholder as before.
          fresh.results.push({
            boxId: row.boxId,
            cell: row.cell,
            description: row.description,
            showMode: '',
            maxPct: null,
            trigger1: null,
            trigger2: null,
            triggerUsed: fresh.triggerChoice === 'trigger2' ? 'Trigger2' : 'Trigger1',
            crossedTrigger: null,
            datePullRequested: '',
            serviceNeeded: null,
            advisory: '',
            lastCycleHours: null,
            notes: 'Chart did not update within ' + (PER_BOX_TIMEOUT_MS / 1000) + 's after Select (retried ' + MAX_TIMEOUT_RETRIES + 'x).',
          });
          fresh.pendingBoxId = null;
          fresh.pendingShowMode = null;
          fresh.pendingPhase = null;
          fresh.pendingResult = null;
          fresh.timeoutRetryBoxId = null;
          fresh.timeoutRetryCount = 0;
          saveState(fresh);
          updateTimerDisplay(fresh);
          log(`✕ Box ${row.boxId}: timed out after ${MAX_TIMEOUT_RETRIES + 1} attempts (${fresh.results.length}/${fresh.boxList.length})`);
          advanceToNextBox(fresh);
        }
      },
      startedAt
    );

    selectRow(row.rowIndex);
  }

  function startScanWithBoxList(rows, inactiveResults, noUpload) {
    // Fetch the Green List ONCE here, before the first box - it rides
    // in the saved state through every page reload of the run, so this
    // is one fetch per scan, not one per box. A failed fetch is
    // non-fatal: the built-in A3_BOX_IDS list takes over and the log
    // says so, so the daily scan can never be stopped by a sheet or
    // network hiccup.
    log('Fetching Green List + Days & Cycles triggers from the Google Sheet...');
    Promise.all([fetchGreenListFromSheet(), fetchDaysCyclesFromSheet()]).then(([greenListIds, daysCyclesMap]) => {
      if (greenListIds) {
        log('Green List loaded from sheet: ' + greenListIds.length + ' boxes.');
      } else {
        log('⚠️ Could not load Green List from the sheet - using the built-in fallback list (' + A3_BOX_IDS.size + ' boxes).');
      }
      if (daysCyclesMap) {
        log('Days & Cycles triggers loaded: ' + Object.keys(daysCyclesMap).length + ' boxes.');
      } else {
        log('⚠️ Could not load Days & Cycles triggers - advisory will show page readings only this run (needs the updated Apps Script deployed).');
      }
      const state = {
        boxList: rows,
        nextIndex: 0,
        pendingBoxId: null,
        pendingShowMode: null,
        pendingPhase: null,
        pendingResult: null,
        results: inactiveResults ? inactiveResults.slice() : [],
        done: false,
        stopRequested: false,
        startedAt: Date.now(),
        triggerChoice: getActiveTriggerChoice(),
        greenListBoxIds: greenListIds, // null = use built-in fallback
        daysCyclesMap: daysCyclesMap, // null = no trigger comparisons this run
        noUpload: noUpload === true, // targeted/diagnostic run - finishScan skips the sheet upload
      };
      saveState(state);
      setRunningUI();
      startTimerTick();
      updateTimerDisplay(state);
      advanceToNextBox(state);
    });
  }

  function startNewScan(limit, boxIds) {
    let rows;
    try {
      rows = getBoxRows();
    } catch (err) {
      log('Error: ' + err.message);
      return;
    }

    let inactiveRows = rows.filter((r) => isInactiveBoxDescription(r.description));
    rows = rows.filter((r) => !isInactiveBoxDescription(r.description));

    // TARGETED run (runner --box, or a manual call with an ID list):
    // scan ONLY the requested boxes, matched as trimmed strings. Filters
    // BOTH the active and inactive lists so the run is exactly the
    // requested boxes and nothing else. A targeted run is a DIAGNOSTIC
    // run: it sets noUpload=true so finishScan does NOT overwrite today's
    // real sheet tab. (limit/--test is ignored when an ID list is given.)
    let noUpload = false;
    if (Array.isArray(boxIds) && boxIds.length) {
      const want = new Set(boxIds.map((b) => String(b).trim()).filter(Boolean));
      const inSet = (r) => want.has(String(r.boxId).trim());
      const foundActive = rows.filter(inSet);
      const foundInactive = inactiveRows.filter(inSet);
      const foundIds = new Set([...foundActive, ...foundInactive].map((r) => String(r.boxId).trim()));
      const missing = [...want].filter((id) => !foundIds.has(id));
      if (missing.length) {
        log('Targeted run: ' + missing.length + ' requested box(es) not found in the grid (inactive-filtered out or not on this page): ' + missing.join(', '));
      }
      rows = foundActive;
      inactiveRows = foundInactive;
      noUpload = true;
      log('TARGETED run: ' + rows.length + ' active box(es) [' + rows.map((r) => r.boxId).join(', ') + '] - console only, sheet will NOT be written.');
    }

    if (inactiveRows.length > 0) {
      console.log('[Box Service Check v2] Skipping ' + inactiveRows.length + ' inactive box(es) (description starts with X/Y/Z).');
    }
    const inactiveResults = inactiveRows.map((r) => ({
      boxId: r.boxId,
      cell: r.cell,
      description: r.description,
      showMode: '',
      maxPct: null,
      trigger1: null,
      trigger2: null,
      triggerUsed: '',
      crossedTrigger: null,
      datePullRequested: '',
      serviceNeeded: null,
      advisory: '',
      lastCycleHours: null,
      notes: 'Box inactive (description starts with X/Y/Z) - not scanned.',
    }));

    const currentBoxId = getBoxId();
    if (currentBoxId) {
      const idx = rows.findIndex((r) => r.boxId === currentBoxId);
      if (idx !== -1 && idx !== rows.length - 1) {
        const [cur] = rows.splice(idx, 1);
        rows.push(cur);
      }
    }

    if (typeof limit === 'number' && limit > 0 && limit < rows.length) {
      rows = rows.slice(0, limit);
      log(`Starting TEST batch: ${rows.length} boxes only.`);
    }

    startScanWithBoxList(rows, inactiveResults, noUpload);
  }

  function doResume(state) {
    setRunningUI();
    startTimerTick();
    updateTimerDisplay(state);
    if (state.pendingBoxId !== null) {
      switch (state.pendingPhase) {
        case 'phase2':
          phase2_setScanCycles(state);
          break;
        case 'phase3':
          // A resume into phase3 happens precisely because clicking
          // "Set No. Cycles" triggers a full PAGE RELOAD on this site,
          // every time, with no exception - the in-memory
          // waitForChartUpdate() polling loop can never observe that
          // src change itself, since the reload destroys its own
          // JavaScript context before the comparison can succeed. That
          // reload IS the successful chart update, not a sign of
          // staleness - by the time we get here (a fresh page load
          // landing back in phase3 with pendingPhase already saved as
          // 'phase3' from before the click), the chart has already
          // re-rendered with the new Cycles value. Trusted here
          // (chartFreshnessUnverified = false).
          phase3_analyze(state, false);
          break;
        case 'phase4':
          phase4_resetScanCycles(state);
          break;
        case 'done':
          finalizeResult(state);
          break;
        case 'phase1':
        default:
          phase1_showMode(state);
          break;
      }
    } else {
      advanceToNextBox(state);
    }
  }

  function promptResume(state) {
    buildPanel();
    const remaining = state.boxList.length - state.results.length;
    const el = document.getElementById('service-check-status');
    const runBtn = document.getElementById('service-check-run-btn');
    const stopBtn = document.getElementById('service-check-stop-btn');
    if (runBtn) runBtn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = 'none';
    if (el) {
      el.innerHTML = `An unfinished scan was found (${state.results.length}/${state.boxList.length} done, ${remaining} remaining, currently on Box ${state.pendingBoxId || '?'}).<br><br>
        <button id="service-check-resume-btn" style="padding:8px 12px; font-size:13px; border:none; border-radius:6px; cursor:pointer; font-weight:700; background:#2980b9; color:white; margin-right:6px;">Resume</button>
        <button id="service-check-discard-btn" style="padding:8px 12px; font-size:13px; border:none; border-radius:6px; cursor:pointer; font-weight:600; background:#7f8c8d; color:white;">Discard</button>`;
    }
    const resumeBtn = document.getElementById('service-check-resume-btn');
    const discardBtn = document.getElementById('service-check-discard-btn');
    if (resumeBtn) {
      resumeBtn.addEventListener('click', () => {
        log('Resuming...');
        doResume(state);
      });
    }
    if (discardBtn) {
      discardBtn.addEventListener('click', () => {
        clearState();
        setIdleUI();
        log('Discarded previous scan. Click "Run Service Check" to start fresh.');
      });
    }
  }

  function resumeIfNeeded() {
    const state = loadState();
    if (!state || state.done) return false;

    const gapMs = Date.now() - (state.lastActivityAt || 0);
    if (gapMs > RESUME_STALE_MS) {
      promptResume(state);
      return true;
    }

    doResume(state);
    return true;
  }

  function init() {
    // v4.5: if we woke up on the login page (expired session redirect
    // to login.aspx), the only job is logging back in - the Returnurl
    // brings us home to Monitor.aspx, where the normal init and the
    // auto-run alarm take over. Retries once a minute (rate-limited
    // inside attemptAutoLogin) in case the first submit fails.
    if (isLoginPage()) {
      attemptAutoLogin();
      setInterval(attemptAutoLogin, 65000);
      return;
    }

    // v4.5.1: parked on any NON-monitor page (Default.aspx after a
    // Logout click, or anything else). When Auto-Run is enabled, walk
    // home to Monitor.aspx - if the session is dead, the server
    // bounces that to login.aspx, where auto-login takes over. Rate
    // limited to one navigation per minute so an unexpected page can
    // never turn into a rapid reload loop. When Auto-Run is OFF the
    // script does nothing here - a human browsing the portal is not
    // our business.
    if (!/\/Monitor\.aspx/i.test(location.pathname)) {
      const NAV_KEY = 'wastenetNavAttemptAt_v1';
      const goHome = () => {
        if (!loadAutoRunConfig().enabled) return;
        const last = parseInt(localStorage.getItem(NAV_KEY) || '0', 10);
        if (Date.now() - last < 60000) return;
        localStorage.setItem(NAV_KEY, String(Date.now()));
        console.log('[AutoRun] Parked on ' + location.pathname + ' - navigating back to Monitor.aspx.');
        location.href = '/Monitor.aspx';
      };
      goHome();
      setInterval(goHome, 65000);
      return;
    }

    const hasActiveScan = (() => {
      const s = loadState();
      return !!(s && !s.done);
    })();

    if (!getTrendGraphImg() && !hasActiveScan) {
      setTimeout(init, 500);
      return;
    }
    buildPanel();
    // v4.5: the alarm clock + overnight keep-alive run for the life
    // of the page. Both are no-ops unless Auto-Run is enabled in the
    // panel, and both stand down while a scan is active.
    startAutoRunTicker();
    startKeepAlive();
    const resumed = resumeIfNeeded();
    if (!resumed) {
      setIdleUI();
      log('Ready. Click "Run Service Check" to start.');
    }
  }

  window.__startBoxServiceCheck = startNewScan;
  window.__clearBoxServiceCheck = clearState;
  window.__debugGetDatePullRequested = getDatePullRequested;
  window.__debugGetLastCycleHours = getLastCycleHours;
  window.__debugWasServiceRequestedRecently = wasServiceRequestedRecently;
  window.__debugGetActiveTriggerChoice = getActiveTriggerChoice;

  init();
})();