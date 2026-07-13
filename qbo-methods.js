/**
 * qbo-methods.js - how was each invoice actually paid?
 *
 * Diagnostic only. READ-ONLY. Nothing is written anywhere - not to
 * QuickBooks, not to the sheet, not to disk (except the token refresh
 * that every one of these scripts does).
 *
 *   node qbo-methods.js                  payments from 2026-01-01
 *   node qbo-methods.js 2025-01-01       payments from that date
 *   node qbo-methods.js --raw            also dump two whole payment
 *                                        records, so we can see every
 *                                        field QuickBooks actually returns
 *
 * WHY THIS EXISTS
 *
 * Money arrives three ways: through the QuickBooks pay-link, by ACH into
 * Frost, or as a cheque in the post. The bank statement can only tell two
 * of those apart - a cheque deposit is a bare lump sum with no name on it
 * at all, so there is no way to know from the bank who paid.
 *
 * The plan was to work out the cheque payers by elimination, across six
 * months of statements. But QuickBooks has a PaymentMethodRef field on
 * every payment, and the nightly pull has simply never asked for it. If
 * that field is filled in, we can READ the answer instead of inferring it,
 * which is better in every way.
 *
 * So this script asks one question and answers it honestly, including the
 * possibility that the answer is "the field is empty and this was a waste
 * of time" - in which case we go back to the statements, having lost
 * twenty minutes rather than built something on a guess.
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
  var msLeft = (tokens.access_expires_at || 0) - Date.now();
  if (msLeft > 5 * 60 * 1000) return;
  console.log('Refreshing access token...');
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

/* QuickBooks caps a query at 1000 rows, so page through. */
async function queryAll(entity, where) {
  var out = [];
  var start = 1;
  var page = 1000;
  for (;;) {
    var sql = 'SELECT * FROM ' + entity + (where ? ' WHERE ' + where : '') +
              ' STARTPOSITION ' + start + ' MAXRESULTS ' + page;
    var res = await query(sql);
    var batch = (res.QueryResponse && res.QueryResponse[entity]) || [];
    out = out.concat(batch);
    if (batch.length < page) break;
    start += page;
  }
  return out;
}

function pad(s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }
function padL(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }
function money(n) { return '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

(async function () {
  try {
    await ensureFreshToken();

    var args = process.argv.slice(2);
    var raw = args.indexOf('--raw') !== -1;
    var since = args.filter(function (a) { return /^\d{4}-\d{2}-\d{2}$/.test(a); })[0] || '2026-01-01';

    console.log('Fetching payments since ' + since + '...\n');
    var pays = await queryAll('Payment', "TxnDate >= '" + since + "'");
    console.log('Payments found: ' + pays.length + '\n');

    if (!pays.length) { console.log('Nothing to look at.'); return; }

    /* ---------------------------------------------------------------
       1. WHAT FIELDS DOES QUICKBOOKS ACTUALLY RETURN?

       Guessing field names is how you end up confidently reporting that
       a field is empty when you simply asked for the wrong one. So list
       what is really there, and how often it is populated.
       --------------------------------------------------------------- */
    var fieldCount = {};
    pays.forEach(function (p) {
      Object.keys(p).forEach(function (k) {
        var v = p[k];
        var present = !(v === null || v === undefined || v === '' ||
                        (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0));
        if (present) fieldCount[k] = (fieldCount[k] || 0) + 1;
      });
    });

    console.log('=== FIELDS PRESENT ON THE PAYMENT RECORD ===');
    Object.keys(fieldCount)
      .sort(function (a, b) { return fieldCount[b] - fieldCount[a]; })
      .forEach(function (k) {
        var n = fieldCount[k];
        var pct = Math.round((n / pays.length) * 100);
        var flag = (k === 'PaymentMethodRef' || k === 'PaymentType' || k === 'TxnSource') ? '  <-- the one we care about' : '';
        console.log('   ' + pad(k, 26) + padL(n, 5) + ' of ' + pays.length + '  (' + padL(pct + '%', 4) + ')' + flag);
      });
    console.log();

    /* ---------------------------------------------------------------
       2. HOW POPULATED IS THE METHOD?

       This is the whole question. If it is blank on most payments, the
       field is decoration and we go back to the bank statements.
       --------------------------------------------------------------- */
    var methodOf = function (p) {
      if (p.PaymentMethodRef && p.PaymentMethodRef.name) return p.PaymentMethodRef.name;
      if (p.PaymentMethodRef && p.PaymentMethodRef.value) return 'id:' + p.PaymentMethodRef.value;
      return '(not set)';
    };

    var byMethod = {};
    pays.forEach(function (p) {
      var m = methodOf(p);
      if (!byMethod[m]) byMethod[m] = { n: 0, total: 0 };
      byMethod[m].n++;
      byMethod[m].total += Number(p.TotalAmt) || 0;
    });

    console.log('=== PAYMENT METHOD, ACROSS ALL PAYMENTS ===');
    Object.keys(byMethod)
      .sort(function (a, b) { return byMethod[b].n - byMethod[a].n; })
      .forEach(function (m) {
        var b = byMethod[m];
        var pct = Math.round((b.n / pays.length) * 100);
        console.log('   ' + pad(m, 24) + padL(b.n, 5) + '  (' + padL(pct + '%', 4) + ')   ' + padL(money(b.total), 14));
      });
    console.log();

    /* TxnSource tells us whether Intuit created the payment itself - which
       is what a pay-link payment looks like. Kim never touches those. */
    var bySource = {};
    pays.forEach(function (p) {
      var s = p.TxnSource || '(none)';
      bySource[s] = (bySource[s] || 0) + 1;
    });
    if (Object.keys(bySource).length > 1 || !bySource['(none)']) {
      console.log('=== TxnSource (who created the payment record) ===');
      Object.keys(bySource).sort(function (a, b) { return bySource[b] - bySource[a]; })
        .forEach(function (s) { console.log('   ' + pad(s, 24) + padL(bySource[s], 5)); });
      console.log();
    }

    /* ---------------------------------------------------------------
       3. WHICH CUSTOMER PAYS HOW?

       The actual deliverable. A customer who only ever pays by cheque is
       one whose invoices we will have to find inside an anonymous lump
       sum on the bank statement.
       --------------------------------------------------------------- */
    var byCust = {};
    pays.forEach(function (p) {
      var c = (p.CustomerRef && p.CustomerRef.name) || '(no customer)';
      if (!byCust[c]) byCust[c] = { methods: {}, n: 0, total: 0, last: '' };
      var b = byCust[c];
      var m = methodOf(p);
      b.methods[m] = (b.methods[m] || 0) + 1;
      b.n++;
      b.total += Number(p.TotalAmt) || 0;
      if (String(p.TxnDate) > b.last) b.last = String(p.TxnDate);
    });

    console.log('=== HOW EACH CUSTOMER PAYS ===');
    console.log('   ' + pad('CUSTOMER', 40) + padL('PMTS', 5) + '  ' + padL('TOTAL', 13) + '   METHODS USED');
    console.log('   ' + '-'.repeat(96));

    Object.keys(byCust).sort().forEach(function (c) {
      var b = byCust[c];
      var ms = Object.keys(b.methods)
        .sort(function (x, y) { return b.methods[y] - b.methods[x]; })
        .map(function (m) { return m + ' \u00d7' + b.methods[m]; })
        .join(', ');
      console.log('   ' + pad(c, 40) + padL(b.n, 5) + '  ' + padL(money(b.total), 13) + '   ' + ms);
    });
    console.log();

    /* ---------------------------------------------------------------
       4. THE ANSWER, STATED PLAINLY
       --------------------------------------------------------------- */
    var notSet = (byMethod['(not set)'] || { n: 0 }).n;
    var setPct = Math.round(((pays.length - notSet) / pays.length) * 100);

    console.log('=== SO: CAN WE READ THE ANSWER, OR MUST WE INFER IT? ===');
    console.log('   Payment method is set on ' + (pays.length - notSet) + ' of ' + pays.length +
                ' payments (' + setPct + '%).');
    if (setPct >= 80) {
      console.log('   -> GOOD. The field is trustworthy. We can read who pays by cheque');
      console.log('      straight from QuickBooks, and no bank statements are needed.');
    } else if (setPct >= 30) {
      console.log('   -> PARTIAL. Useful, but not the whole story. The payments Intuit');
      console.log('      created itself will be reliable; the ones Kim keyed by hand may');
      console.log('      not be. Look at the per-customer table above before trusting it.');
    } else {
      console.log('   -> NO. The field is not being filled in. Reading it is a dead end,');
      console.log('      and we go back to deriving cheque payers from six months of');
      console.log('      Frost statements, as originally planned. No harm done.');
    }
    console.log();

    if (raw) {
      console.log('=== TWO WHOLE PAYMENT RECORDS, VERBATIM ===');
      console.log('(so we can see every field QuickBooks returns, not just the ones I thought to ask for)\n');
      pays.slice(0, 2).forEach(function (p, i) {
        console.log('--- payment ' + (i + 1) + ' ---');
        console.log(JSON.stringify(p, null, 2));
        console.log();
      });
    } else {
      console.log('Run with --raw to dump two complete payment records.');
    }

  } catch (err) {
    console.error('ERROR: ' + (err && err.message ? err.message : String(err)));
    if (err && err.authResponse) {
      try { console.error(JSON.stringify(err.authResponse.json, null, 2)); } catch (e) {}
    }
    process.exit(1);
  }
})();
