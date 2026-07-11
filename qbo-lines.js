/**
 * qbo-lines.js - survey every invoice line in the books.
 *
 * READ-ONLY. Nothing is written to QuickBooks, the sheet, or anywhere else.
 *
 * WHY
 *   Agent payouts are (paid - boxes x $25) x share. That needs a box
 *   count, and the box count comes from invoice lines. But not every line
 *   is a box: some are one-time charges (new box, replacement) that carry
 *   no commission.
 *
 *   Telling them apart is the whole problem, and the evidence so far is
 *   contradictory. Kim says monitoring lines say "monthly monitoring" -
 *   but every one of Costco's 243 box lines is a bare address with no
 *   such wording. So neither "must say monitoring" nor "must not say
 *   replacement" can be trusted on a hunch.
 *
 *   This script doesn't guess. It reads every line in the company and
 *   reports what is actually there, so the rule can be written against
 *   reality and the leftovers can be looked at by a human.
 *
 * USAGE
 *   node qbo-lines.js               survey everything
 *   node qbo-lines.js --since 2025  only invoices from 2025 on
 */

require('dotenv').config();

var fs = require('fs');
var path = require('path');
var OAuthClient = require('intuit-oauth');

var TOKENS_PATH = path.join(__dirname, 'qbo-tokens.json');
var tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
var environment = (tokens.environment || 'production').toLowerCase();

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

var SINCE = (function () {
  var i = process.argv.indexOf('--since');
  return i !== -1 ? process.argv[i + 1] : null;
})();

/* ---------------- auth ---------------- */

function saveTokens(t) {
  fs.writeFileSync(TOKENS_PATH, JSON.stringify({
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    realmId: tokens.realmId,
    environment: environment,
    access_expires_at: Date.now() + (t.expires_in * 1000),
    refresh_expires_at: Date.now() + (t.x_refresh_token_expires_in * 1000),
    obtained_at: new Date().toISOString()
  }, null, 2));
}

async function ensureFreshToken() {
  if (((tokens.access_expires_at || 0) - Date.now()) > 5 * 60 * 1000) return;
  log('Refreshing access token...');
  var r = await oauthClient.refresh();
  var t = r.getJson();
  saveTokens(t);
  tokens.access_token = t.access_token;
  tokens.refresh_token = t.refresh_token;
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

/* ---------------- classification ----------------
 *
 * A CANDIDATE rule, deliberately conservative:
 *
 *   CHARGE     - the description names a one-time event (replacement,
 *                new box, install...). These never earn commission.
 *   MONITORING - says monitoring outright.
 *   BARE       - neither. Costco's box lines look like this: just an
 *                address. Probably monitoring, but that is an assumption,
 *                so it gets counted separately rather than folded in.
 *
 * The script reports all three. Whatever ends up in BARE and UNSURE is
 * exactly what a human needs to look at before this rule goes anywhere
 * near a payout.
 */

var CHARGE_WORDS = [
  'replacement', 'replace', 'new box', 'install', 'installation',
  'setup', 'set up', 'set-up', 'purchase', 'equipment', 'repair',
  'shipping', 'freight', 'deposit', 'one time', 'one-time', 'onetime'
];

var MONITOR_WORDS = ['monitoring', 'monitor'];

function classify(desc, rate) {
  var d = String(desc || '').toLowerCase();

  for (var i = 0; i < CHARGE_WORDS.length; i++) {
    if (d.indexOf(CHARGE_WORDS[i]) !== -1) return 'CHARGE';
  }
  for (var j = 0; j < MONITOR_WORDS.length; j++) {
    if (d.indexOf(MONITOR_WORDS[j]) !== -1) return 'MONITORING';
  }
  if (!d.trim()) return 'EMPTY';
  return 'BARE';
}

/* ---------------- main ---------------- */

(async function () {
  try {
    await ensureFreshToken();
    log('Reading invoice lines from ' + environment + ' company...');
    if (SINCE) log('  (invoices dated ' + SINCE + '-01-01 onward)');

    var PAGE = 500;   // Line data is heavy; smaller pages than usual.
    var start = 1;
    var invoices = [];

    while (true) {
      var where = SINCE ? " WHERE TxnDate >= '" + SINCE + "-01-01'" : '';
      var sql = 'SELECT * FROM Invoice' + where +
                ' STARTPOSITION ' + start + ' MAXRESULTS ' + PAGE;
      var res = await query(sql);
      var batch = (res.QueryResponse && res.QueryResponse.Invoice) || [];
      invoices = invoices.concat(batch);
      log('  ' + invoices.length + ' invoices...');
      if (batch.length < PAGE) break;
      start += PAGE;
    }

    log('Invoices: ' + invoices.length);
    log('');

    var buckets = { MONITORING: [], BARE: [], CHARGE: [], EMPTY: [] };
    var rateHist = {};       // class -> { rate -> count }
    var totalLines = 0;

    invoices.forEach(function (inv) {
      (inv.Line || []).forEach(function (ln) {
        var det = ln.SalesItemLineDetail;
        if (!det) return;         // subtotals, discounts etc.
        totalLines++;

        var desc = ln.Description || '';
        var rate = det.UnitPrice;
        var qty  = det.Qty;
        var cls  = classify(desc, rate);

        buckets[cls].push({
          desc: desc,
          rate: rate,
          qty: qty,
          amount: ln.Amount,
          customer: (inv.CustomerRef && inv.CustomerRef.name) || '',
          doc: inv.DocNumber || inv.Id
        });

        if (!rateHist[cls]) rateHist[cls] = {};
        var rk = rate == null ? '(none)' : String(rate);
        rateHist[cls][rk] = (rateHist[cls][rk] || 0) + 1;
      });
    });

    log('=== LINE CLASSES (' + totalLines + ' lines) ===');
    ['MONITORING', 'BARE', 'CHARGE', 'EMPTY'].forEach(function (k) {
      var pct = totalLines ? (buckets[k].length / totalLines * 100).toFixed(1) : '0';
      log('  ' + pad(k, 11) + ' ' + pad(String(buckets[k].length), 6) + '  (' + pct + '%)');
    });
    log('');

    /* --- what CHARGE actually caught. These are the lines that would be
           excluded from commission, so they deserve a close look. --- */
    log('=== CHARGE lines - EXCLUDED from box count and commission ===');
    log('    (' + buckets.CHARGE.length + ' lines. Every distinct description:)');
    var chargeDescs = {};
    buckets.CHARGE.forEach(function (l) {
      var key = l.desc.slice(0, 70);
      if (!chargeDescs[key]) chargeDescs[key] = { n: 0, rates: {}, cust: l.customer };
      chargeDescs[key].n++;
      chargeDescs[key].rates[l.rate] = true;
    });
    Object.keys(chargeDescs).sort().slice(0, 60).forEach(function (d) {
      var c = chargeDescs[d];
      log('  x' + pad(String(c.n), 4) + ' $' + Object.keys(c.rates).join('/') +
          '  ' + c.cust.slice(0, 22) + '  "' + d + '"');
    });
    if (Object.keys(chargeDescs).length > 60) {
      log('  ... and ' + (Object.keys(chargeDescs).length - 60) + ' more distinct descriptions');
    }
    log('');

    /* --- rate spread per class. If charges and monitoring overlap on
           rate, then rate alone can never be the rule. --- */
    log('=== RATE SPREAD BY CLASS ===');
    ['MONITORING', 'BARE', 'CHARGE'].forEach(function (k) {
      var rates = Object.keys(rateHist[k] || {})
        .filter(function (r) { return r !== '(none)'; })
        .map(Number).sort(function (a, b) { return a - b; });
      if (!rates.length) { log('  ' + pad(k, 11) + ' (none)'); return; }
      log('  ' + pad(k, 11) + ' min $' + rates[0] +
          '   max $' + rates[rates.length - 1] +
          '   distinct rates: ' + rates.length);
    });
    log('');

    /* --- the thing that decides whether a rate threshold is safe --- */
    var monMax = maxRate(rateHist.MONITORING, rateHist.BARE);
    var chgMin = minRate(rateHist.CHARGE);
    log('=== CAN RATE ALONE SEPARATE THEM? ===');
    if (chgMin == null || monMax == null) {
      log('  Not enough data to say.');
    } else if (chgMin > monMax) {
      log('  YES - cleanly. Highest box-ish rate $' + monMax +
          ', cheapest charge $' + chgMin + '. No overlap.');
    } else {
      log('  NO - they OVERLAP. Box-ish rates reach $' + monMax +
          ' and charges start at $' + chgMin + '.');
      log('  A price threshold would misclassify real lines. Description must decide.');
    }
    log('');

    /* --- BARE: no monitoring wording, no charge wording. Costco lives
           here. This is the bucket that needs a human eye. --- */
    log('=== BARE lines - no wording either way (sample of 25) ===');
    var byCust = {};
    buckets.BARE.forEach(function (l) {
      byCust[l.customer] = (byCust[l.customer] || 0) + 1;
    });
    log('  Customers with BARE lines:');
    Object.keys(byCust).sort(function (a, b) { return byCust[b] - byCust[a]; })
      .slice(0, 15).forEach(function (c) {
        log('    ' + pad(String(byCust[c]), 6) + '  ' + c);
      });
    log('');
    buckets.BARE.slice(0, 25).forEach(function (l) {
      log('    $' + pad(String(l.rate), 6) + ' ' + pad(l.customer.slice(0, 20), 21) +
          ' "' + String(l.desc).slice(0, 45) + '"');
    });
    log('');

    /* --- highest-value lines. A big number that ISN'T a charge is
           exactly the kind of thing that silently breaks a payout. --- */
    log('=== 20 HIGHEST-RATE LINES NOT CLASSED AS CHARGE ===');
    log('    (if any of these are really one-time fees, the rule has a hole)');
    buckets.MONITORING.concat(buckets.BARE)
      .filter(function (l) { return l.rate != null; })
      .sort(function (a, b) { return b.rate - a.rate; })
      .slice(0, 20)
      .forEach(function (l) {
        log('    $' + pad(String(l.rate), 7) + ' inv ' + pad(String(l.doc), 6) +
            ' ' + pad(l.customer.slice(0, 20), 21) +
            ' "' + String(l.desc).slice(0, 42) + '"');
      });
    log('');

    log('=== WHAT THIS MEANS ===');
    log('  Lines that would count as boxes: ' +
        (buckets.MONITORING.length + buckets.BARE.length));
    log('  Lines excluded as one-time charges: ' + buckets.CHARGE.length);
    log('  Lines with no description at all: ' + buckets.EMPTY.length);
    log('');
    log('  Read the CHARGE list above: is anything there actually monitoring?');
    log('  Read the high-rate list above: is anything there actually a charge?');
    log('  Either mistake changes what an agent gets paid.');

  } catch (e) {
    var j = e && e.getJson && (function () {
      try { return e.getJson(); } catch (_) { return null; }
    })();
    console.error('ERROR: ' + ((j && JSON.stringify(j)) || e.message || String(e)));
    process.exit(1);
  }
})();

/* ---------------- helpers ---------------- */

function maxRate() {
  var m = null;
  for (var i = 0; i < arguments.length; i++) {
    Object.keys(arguments[i] || {}).forEach(function (r) {
      if (r === '(none)') return;
      var n = Number(r);
      if (m === null || n > m) m = n;
    });
  }
  return m;
}

function minRate(h) {
  var m = null;
  Object.keys(h || {}).forEach(function (r) {
    if (r === '(none)') return;
    var n = Number(r);
    if (m === null || n < m) m = n;
  });
  return m;
}

function pad(s, n) {
  s = String(s);
  while (s.length < n) s += ' ';
  return s;
}

function log(m) { console.log(m); }
