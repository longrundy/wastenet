/**
 * qbo-boxmatch.js - work out which QuickBooks customer each CES box belongs to.
 *
 * READ-ONLY. Writes nothing anywhere. Prints a report.
 *
 * WHY
 *   The billing draft can warn that a box count moved, but only by comparing
 *   two past invoices. To say "CES shows 26 boxes and you billed 25" it needs
 *   to know which customer each box belongs to - and nothing joins them.
 *
 *   The obvious route was a mapping tab: 57 CES client names, matched by hand
 *   to QuickBooks customers. Workable, but it needed a person to decide which
 *   of the four Raley's entities each store belonged to, and a person can get
 *   that wrong.
 *
 *   The better route was sitting in the data the whole time. QuickBooks bills
 *   one line per box, and the line says WHERE the box is:
 *
 *     Costco Inc   "#1243- 7300 SR 161 E- Plain City, OH"
 *     Raley's      "Nob Hill 605 ( 1700 Airline Hwy., Hollister, )"
 *
 *   And CES describes the same box the same way:
 *
 *     "Costco 1190 - 18109 33rd Ave W - Lynnwood, WA"
 *     "R- 603 NOB HILL - 451 Vinyard Town Center - Morgan Hill, CA"
 *
 *   So the customer does not have to be guessed. It can be READ, from the
 *   invoice that billed for that box. QuickBooks already knows the answer -
 *   it has been billing these boxes for years.
 *
 *   That also settles Raley's without anyone deciding anything: a Nob Hill
 *   store is billed on the Nob Hill invoice, so the store number tells you
 *   which entity it belongs to.
 *
 * HOW IT MATCHES
 *   1. STORE NUMBER - the strongest key. Costco lines carry "#1243"; CES
 *      carries "Costco 1190". Raley's lines carry "605"; CES carries
 *      "R- 603 NOB HILL". An exact number match is near-certain.
 *   2. STREET ADDRESS - the house number plus the street name, normalised.
 *      Catches everything without a store number.
 *
 *   Anything matched both ways and disagreeing is reported, not resolved.
 *
 * USAGE
 *   node qbo-boxmatch.js
 */

require('dotenv').config();

var fs = require('fs');
var path = require('path');
var OAuthClient = require('intuit-oauth');

var TOKENS_PATH = path.join(__dirname, 'qbo-tokens.json');
var tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
var environment = (tokens.environment || 'production').toLowerCase();

/* The box sheet. Read via its public CSV export, so this needs no Google
   credentials - the sheet is already reachable by the scanner. */
var BOX_SHEET_ID = '18q7B4a2WLmnSnvAQ51u8D5Wy4_mfSIeCKBFVsl39lfc';
var BOX_TAB_NAME = 'Master Box List';

var oauthClient = new OAuthClient({
  clientId: process.env.QBO_CLIENT_ID,
  clientSecret: process.env.QBO_CLIENT_SECRET,
  environment: environment,
  redirectUri: 'https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl',
  token: {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_type: 'bearer',
    expires_in: 3600,
    x_refresh_token_expires_in: 8726400,
    realmId: tokens.realmId
  }
});

var API_BASE = environment === 'production'
  ? 'https://quickbooks.api.intuit.com'
  : 'https://sandbox-quickbooks.api.intuit.com';

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

async function ensureFreshToken() {
  if (((tokens.access_expires_at || 0) - Date.now()) > 5 * 60 * 1000) return;
  log('Refreshing access token...');
  var r = await oauthClient.refresh();
  var t = r.getJson();
  fs.writeFileSync(TOKENS_PATH, JSON.stringify({
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    realmId: tokens.realmId,
    environment: environment,
    access_expires_at: Date.now() + (t.expires_in * 1000),
    refresh_expires_at: Date.now() + (t.x_refresh_token_expires_in * 1000),
    obtained_at: new Date().toISOString()
  }, null, 2));
  tokens.access_token = t.access_token;
  tokens.access_expires_at = Date.now() + (t.expires_in * 1000);
}

async function query(sql) {
  var url = API_BASE + '/v3/company/' + tokens.realmId +
            '/query?query=' + encodeURIComponent(sql) + '&minorversion=73';
  var resp = await oauthClient.makeApiCall({
    url: url, method: 'GET', headers: { Accept: 'application/json' }
  });
  if (resp.json) return resp.json;
  if (typeof resp.getJson === 'function') return resp.getJson();
  var raw = resp.body || resp.text || resp.data;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

/* ------------------------------------------------------------------ */
/* Keys                                                                */
/* ------------------------------------------------------------------ */

/**
 * The strongest key available: a store number.
 *
 * Costco lines say "#1243- ..." and CES says "Costco 1190 - ...".
 * Raley's lines say "Nob Hill 605 (...)" or "239(7847 Lichen Drive...)",
 * and CES says "R- 603 NOB HILL - ...".
 *
 * Deliberately narrow. A number that might be a house number is not a store
 * number, so only leading, clearly-delimited numbers count.
 */
function storeNumber(s) {
  s = String(s || '').trim();

  // "#1243-", "# 1294 -"
  var m = s.match(/^#\s*(\d{1,4})\b/);
  if (m) return pad4(m[1]);

  // "Costco 1190 - ", "Costco Corp [1193]"
  m = s.match(/^costco(?:\s+corp)?\s*\[?\s*(\d{1,4})\b/i);
  if (m) return pad4(m[1]);

  // "R- 603 NOB HILL", "R-114 CARSON CITY"
  m = s.match(/^R\s*-\s*(\d{1,4})\b/i);
  if (m) return pad4(m[1]);

  // "Nob Hill 605 (", "Raley's 109 ("
  m = s.match(/^(?:nob hill|bel air|raley'?s|food source)\s+(\d{1,4})\b/i);
  if (m) return pad4(m[1]);

  // "239(7847 Lichen Drive...", "114 (3701 S.Carson St..."
  m = s.match(/^(\d{1,4})\s*\(/);
  if (m) return pad4(m[1]);

  return '';
}

function pad4(n) {
  n = String(parseInt(n, 10));
  while (n.length < 4) n = '0' + n;
  return n;
}

/**
 * House number + street name, normalised hard.
 *
 * Enough to survive the differences between how CES and QuickBooks write the
 * same address, without being so loose that two different addresses collide.
 */
function addressKey(s) {
  s = String(s || '').toLowerCase();

  var m = s.match(/(\d{2,6})\s+([a-z0-9][a-z0-9.'\- ]{3,40}?)(?:\s*[,\[\(]|\s+-\s|$)/);
  if (!m) return '';

  var num = m[1];
  var street = m[2]
    .replace(/\b(north|south|east|west|n|s|e|w)\b\.?/g, '')
    .replace(/\b(street|st|avenue|ave|road|rd|drive|dr|boulevard|blvd|lane|ln|way|parkway|pkwy|highway|hwy|circle|cir|court|ct|place|pl|suite|ste)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();

  if (street.length < 3) return '';
  return num + ':' + street;
}

/* ------------------------------------------------------------------ */
/* Box sheet                                                           */
/* ------------------------------------------------------------------ */

function fetchBoxSheet() {
  var url = 'https://docs.google.com/spreadsheets/d/' + BOX_SHEET_ID +
            '/gviz/tq?tqx=out:csv&sheet=' + encodeURIComponent(BOX_TAB_NAME);

  return new Promise(function (resolve, reject) {
    require('https').get(url, function (res) {
      if (res.statusCode === 302 || res.statusCode === 307) {
        require('https').get(res.headers.location, function (r2) {
          var b = ''; r2.on('data', function (c) { b += c; }); r2.on('end', function () { resolve(b); });
        }).on('error', reject);
        return;
      }
      var b = ''; res.on('data', function (c) { b += c; }); res.on('end', function () { resolve(b); });
    }).on('error', reject);
  });
}

/** Minimal CSV parse - the descriptions contain commas and quotes. */
function parseCsv(text) {
  var rows = [], row = [], cell = '', q = false;
  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else {
      if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (c !== '\r') cell += c;
    }
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

(async function () {
  try {
    await ensureFreshToken();

    /* --- 1. every box line QuickBooks has billed, this year --- */
    log('Reading invoice lines from QuickBooks...');
    var invs = [];
    var start = 1;
    while (true) {
      var res = await query(
        "SELECT * FROM Invoice WHERE TxnDate >= '2026-01-01' STARTPOSITION " + start + ' MAXRESULTS 500'
      );
      var batch = (res.QueryResponse && res.QueryResponse.Invoice) || [];
      invs = invs.concat(batch);
      if (batch.length < 500) break;
      start += 500;
    }
    log('  ' + invs.length + ' invoices');

    var byStore = {};   // store number -> { customer -> count }
    var byAddr  = {};   // address key  -> { customer -> count }
    var lines = 0;

    invs.forEach(function (inv) {
      var cust = (inv.CustomerRef && inv.CustomerRef.name) || '';
      if (!cust) return;

      (inv.Line || []).forEach(function (ln) {
        var det = ln.SalesItemLineDetail;
        if (!det || det.UnitPrice == null) return;

        var d = String(ln.Description || '');
        if (!d) return;
        lines++;

        var sn = storeNumber(d);
        if (sn) {
          if (!byStore[sn]) byStore[sn] = {};
          byStore[sn][cust] = (byStore[sn][cust] || 0) + 1;
        }

        var ak = addressKey(d);
        if (ak) {
          if (!byAddr[ak]) byAddr[ak] = {};
          byAddr[ak][cust] = (byAddr[ak][cust] || 0) + 1;
        }
      });
    });

    log('  ' + lines + ' billed lines');
    log('  ' + Object.keys(byStore).length + ' distinct store numbers');
    log('  ' + Object.keys(byAddr).length + ' distinct addresses');
    log('');

    /* --- 2. every active box in CES --- */
    log('Reading Master Box List...');
    var csv = parseCsv(await fetchBoxSheet());
    var head = csv[0] || [];
    var iId   = head.indexOf('Box ID');
    var iDesc = head.indexOf('Description');
    if (iId === -1 || iDesc === -1) {
      throw new Error('Could not find "Box ID" / "Description" columns. Found: ' + head.join(' | '));
    }

    var boxes = [];
    for (var r = 1; r < csv.length; r++) {
      var id = String(csv[r][iId] || '').trim();
      var de = String(csv[r][iDesc] || '').trim();
      if (!id || !de) continue;
      boxes.push({ id: id, desc: de });
    }
    log('  ' + boxes.length + ' boxes');
    log('');

    /* --- 3. match --- */
    var pick = function (m) {
      if (!m) return null;
      var best = null, n = 0, total = 0;
      Object.keys(m).forEach(function (c) {
        total += m[c];
        if (m[c] > n) { n = m[c]; best = c; }
      });
      return { customer: best, confidence: n / total, alternatives: Object.keys(m).length };
    };

    var matched = [], unmatched = [], conflicts = [];
    var byStoreHits = 0, byAddrHits = 0;

    boxes.forEach(function (b) {
      var sn = storeNumber(b.desc);
      var ak = addressKey(b.desc);

      var s = sn ? pick(byStore[sn]) : null;
      var a = ak ? pick(byAddr[ak])  : null;

      // Both keys, different answers - report rather than choose.
      if (s && a && s.customer !== a.customer) {
        conflicts.push({ box: b, store: s.customer, addr: a.customer, desc: b.desc });
      }

      var hit = s || a;
      if (!hit) { unmatched.push(b); return; }

      if (s) byStoreHits++; else byAddrHits++;
      matched.push({ box: b, customer: hit.customer, via: s ? 'store#' : 'address' });
    });

    /* --- 4. report --- */
    var pct = function (n) { return (n / boxes.length * 100).toFixed(1) + '%'; };

    log('=== MATCHED ===');
    log('  by store number: ' + byStoreHits + '  (' + pct(byStoreHits) + ')');
    log('  by address:      ' + byAddrHits + '  (' + pct(byAddrHits) + ')');
    log('  TOTAL:           ' + matched.length + '  (' + pct(matched.length) + ')');
    log('  unmatched:       ' + unmatched.length + '  (' + pct(unmatched.length) + ')');
    log('  conflicts:       ' + conflicts.length);
    log('');

    log('=== BOXES PER CUSTOMER (from the match) ===');
    var perCust = {};
    matched.forEach(function (m) { perCust[m.customer] = (perCust[m.customer] || 0) + 1; });
    Object.keys(perCust).sort(function (a, b) { return perCust[b] - perCust[a]; })
      .forEach(function (c) {
        log('  ' + pad(String(perCust[c]), 5) + c);
      });
    log('');

    if (conflicts.length) {
      log('=== CONFLICTS - store number and address disagree ===');
      conflicts.slice(0, 15).forEach(function (c) {
        log('  box ' + pad(c.box.id, 6) + 'store#=' + pad(c.store, 30) + 'address=' + c.addr);
        log('        "' + c.desc.slice(0, 66) + '"');
      });
      if (conflicts.length > 15) log('  ... and ' + (conflicts.length - 15) + ' more');
      log('');
    }

    if (unmatched.length) {
      log('=== UNMATCHED - no billed line found for these boxes ===');
      log('    (either never billed, or the address is written too differently)');
      unmatched.slice(0, 30).forEach(function (b) {
        log('  box ' + pad(b.id, 6) + '"' + b.desc.slice(0, 70) + '"');
      });
      if (unmatched.length > 30) log('  ... and ' + (unmatched.length - 30) + ' more');
      log('');
    }

    log('=== READING ===');
    if (matched.length / boxes.length > 0.9) {
      log('  Over 90% matched. The mapping can be built from the invoices, and');
      log('  nobody has to hand-map 57 client names.');
    } else {
      log('  Under 90%. Worth looking at the unmatched list before relying on this.');
    }

  } catch (e) {
    var j = e && e.getJson && (function () { try { return e.getJson(); } catch (_) { return null; } })();
    console.error('ERROR: ' + ((j && JSON.stringify(j)) || e.message || String(e)));
    process.exit(1);
  }
})();

function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
function log(m) { console.log(m); }
