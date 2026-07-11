/**
 * qbo-pull.js - WasteNet QuickBooks Online pull
 *
 * Reads from the production QuickBooks company and POSTs to the WasteNet
 * Accounting Dashboard Apps Script:
 *
 *   Invoices  - what is owed and what is settled
 *   Payments  - WHEN money actually arrived, and against which invoice
 *
 * The Payments pull is what makes monthly commissions possible. An
 * invoice's Balance tells us THAT it was paid; only a Payment tells us
 * WHEN. Agents are paid for the month the money landed, so the payment
 * date is the commission period.
 *
 * A single QuickBooks payment can settle several invoices, and it links
 * to them by internal Id (not the invoice number a human sees). So we
 * fan each payment out into one row per invoice application, and map
 * the internal Id back to the invoice number using the invoice list we
 * already fetched.
 *
 * USAGE
 *   node qbo-pull.js           full run: fetch + post to the sheet
 *   node qbo-pull.js --test    fetch only, print a summary, post NOTHING
 *
 * READ-ONLY against QuickBooks. This script never writes to QBO.
 */

require('dotenv').config();

var fs = require('fs');
var path = require('path');
var https = require('https');
var OAuthClient = require('intuit-oauth');

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

var TOKENS_PATH = path.join(__dirname, 'qbo-tokens.json');

var SHEET_ENDPOINT =
  'https://script.google.com/macros/s/AKfycbwvvAfVChkEJPlgz8c0iRbH23YIrtxM7SGjm5YgNz-kgs43N7hCGtd8nqBewJJOt8mV/exec';
var SHEET_KEY = 'TRA$H';

var TEST_MODE = process.argv.indexOf('--test') !== -1;

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */

if (!fs.existsSync(TOKENS_PATH)) {
  fail('No qbo-tokens.json found. Run: node qbo-auth.js');
}

var tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));

var environment = (tokens.environment || process.env.QBO_ENVIRONMENT || 'sandbox').toLowerCase();

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
/* Token freshness                                                     */
/* ------------------------------------------------------------------ */

function saveTokens(t) {
  var record = {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    realmId: tokens.realmId,
    environment: environment,
    access_expires_at: Date.now() + (t.expires_in * 1000),
    refresh_expires_at: Date.now() + (t.x_refresh_token_expires_in * 1000),
    obtained_at: new Date().toISOString()
  };
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(record, null, 2));
  try { fs.chmodSync(TOKENS_PATH, 0o600); } catch (e) {}
}

async function ensureFreshToken() {
  var msLeft = (tokens.access_expires_at || 0) - Date.now();
  var minLeft = Math.round(msLeft / 60000);

  // Refresh if under 5 minutes left, so a long run can't expire mid-flight.
  if (msLeft > 5 * 60 * 1000) {
    log('Access token still valid (~' + minLeft + ' min left).');
    return;
  }

  log('Access token expired or expiring. Refreshing...');
  var r = await oauthClient.refresh();
  var t = r.getJson();
  saveTokens(t);
  tokens.access_token = t.access_token;
  tokens.refresh_token = t.refresh_token;
  tokens.access_expires_at = Date.now() + (t.expires_in * 1000);
  log('Refreshed OK.');
}

/* ------------------------------------------------------------------ */
/* QuickBooks query                                                    */
/* ------------------------------------------------------------------ */

async function query(sql) {
  var url = API_BASE + '/v3/company/' + tokens.realmId +
            '/query?query=' + encodeURIComponent(sql) + '&minorversion=73';
  var resp = await oauthClient.makeApiCall({
    url: url,
    method: 'GET',
    headers: { Accept: 'application/json' }
  });
  if (resp.json) return resp.json;
  if (typeof resp.getJson === 'function') return resp.getJson();
  var raw = resp.body || resp.text || resp.data;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

/**
 * QuickBooks caps any query at 1000 rows, so page through with
 * STARTPOSITION until a short page tells us we've reached the end.
 */
async function queryAll(entity, fields) {
  var PAGE = 1000;
  var start = 1;
  var out = [];

  while (true) {
    var sql = 'SELECT ' + fields + ' FROM ' + entity +
              ' STARTPOSITION ' + start + ' MAXRESULTS ' + PAGE;
    var res = await query(sql);
    var batch = (res.QueryResponse && res.QueryResponse[entity]) || [];

    out = out.concat(batch);
    log('  fetched ' + out.length + ' ' + entity + '...');

    if (batch.length < PAGE) break;
    start += PAGE;
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Post to the sheet                                                   */
/* ------------------------------------------------------------------ */

function postToSheet(invoices, payments) {
  return new Promise(function (resolve, reject) {
    var payload = JSON.stringify({
      invoices: invoices,
      payments: payments,
      pulledAt: new Date().toISOString()
    });

    var url = new URL(SHEET_ENDPOINT);
    url.searchParams.set('key', SHEET_KEY);

    var opts = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    var req = https.request(url, opts, function (res) {
      // Apps Script answers with a 302 to a googleusercontent URL. Follow it.
      if (res.statusCode === 302 && res.headers.location) {
        https.get(res.headers.location, function (r2) {
          var body = '';
          r2.on('data', function (c) { body += c; });
          r2.on('end', function () { resolve(body); });
        }).on('error', reject);
        return;
      }
      var body = '';
      res.on('data', function (c) { body += c; });
      res.on('end', function () { resolve(body); });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

(async function main() {
  try {
    await ensureFreshToken();

    log('Connected to ' + environment + ' company realmId=' + tokens.realmId);
    if (TEST_MODE) log('TEST MODE - nothing will be written to the sheet.');

    /* --- Customers: invoices and payments carry only a ref id --- */
    log('Fetching customers...');
    var customers = await queryAll('Customer', 'Id, DisplayName');
    var nameById = {};
    customers.forEach(function (c) { nameById[String(c.Id)] = c.DisplayName; });
    log('Customers: ' + customers.length);

    /* --- Invoices --- */
    log('Fetching invoices...');
    var rawInv = await queryAll(
      'Invoice',
      'Id, DocNumber, TxnDate, DueDate, TotalAmt, Balance, CustomerRef'
    );
    log('Invoices: ' + rawInv.length);

    // Invoice internal Id -> human invoice number. Payments link by Id.
    var docById = {};

    var invoices = rawInv.map(function (i) {
      var custId = i.CustomerRef && i.CustomerRef.value;
      var doc = i.DocNumber || i.Id;
      docById[String(i.Id)] = doc;
      return {
        id:        i.Id,
        docNumber: doc,
        txnDate:   i.TxnDate || '',
        dueDate:   i.DueDate || '',
        customer:  nameById[String(custId)] ||
                   (i.CustomerRef && i.CustomerRef.name) || '',
        total:     Number(i.TotalAmt) || 0,
        balance:   Number(i.Balance) || 0
      };
    });

    invoices.sort(function (a, b) {
      return String(b.txnDate).localeCompare(String(a.txnDate));
    });

    /* --- Payments --- */
    log('Fetching payments...');
    var rawPay = await queryAll(
      'Payment',
      'Id, TxnDate, TotalAmt, CustomerRef, Line'
    );
    log('Payments: ' + rawPay.length);

    // Fan each payment out into one row per invoice it settled.
    var payments = [];
    var unapplied = 0;

    rawPay.forEach(function (p) {
      var custId = p.CustomerRef && p.CustomerRef.value;
      var custName = nameById[String(custId)] ||
                     (p.CustomerRef && p.CustomerRef.name) || '';
      var lines = p.Line || [];
      var linked = 0;

      lines.forEach(function (ln) {
        var txns = ln.LinkedTxn || [];
        txns.forEach(function (t) {
          if (t.TxnType !== 'Invoice') return;
          linked++;
          payments.push({
            paymentId: p.Id,
            txnDate:   p.TxnDate || '',
            customer:  custName,
            docNumber: docById[String(t.TxnId)] || t.TxnId,
            amount:    Number(ln.Amount) || 0
          });
        });
      });

      // A payment with no invoice link is a credit / unapplied balance.
      // Keep it, with a blank invoice number, so the money is not lost.
      if (linked === 0) {
        unapplied++;
        payments.push({
          paymentId: p.Id,
          txnDate:   p.TxnDate || '',
          customer:  custName,
          docNumber: '',
          amount:    Number(p.TotalAmt) || 0
        });
      }
    });

    payments.sort(function (a, b) {
      return String(b.txnDate).localeCompare(String(a.txnDate));
    });

    /* --- Summary --- */
    var open = invoices.filter(function (i) { return i.balance !== 0; });
    var owed = open.reduce(function (s, i) { return s + i.balance; }, 0);
    var collected = payments.reduce(function (s, p) { return s + p.amount; }, 0);

    // Money collected per month - this is the commission period grain.
    var byMonth = {};
    payments.forEach(function (p) {
      var m = String(p.txnDate).slice(0, 7);
      if (!m) return;
      byMonth[m] = (byMonth[m] || 0) + p.amount;
    });
    var months = Object.keys(byMonth).sort().reverse();

    log('');
    log('  Invoices:        ' + invoices.length);
    log('    open:          ' + open.length + '  ($' + owed.toFixed(2) + ' outstanding)');
    log('    paid:          ' + (invoices.length - open.length));
    log('  Payment rows:    ' + payments.length + '  ($' + collected.toFixed(2) + ' collected)');
    log('    unapplied:     ' + unapplied + ' (no invoice link)');
    log('');

    log('Collected by month (6 most recent):');
    months.slice(0, 6).forEach(function (m) {
      log('   ' + m + '   $' + byMonth[m].toFixed(2));
    });
    log('');

    log('Sample payments (5 newest):');
    payments.slice(0, 5).forEach(function (p) {
      log('   ' + p.txnDate + '  ' + p.customer +
          '  inv ' + (p.docNumber || '(unapplied)') +
          '  $' + p.amount.toFixed(2));
    });
    log('');

    if (TEST_MODE) {
      log('TEST MODE - done. Nothing posted. Re-run without --test to write.');
      return;
    }

    log('Posting ' + invoices.length + ' invoices and ' +
        payments.length + ' payment rows...');
    var resp = await postToSheet(invoices, payments);
    log('Sheet replied: ' + resp);
    log('DONE.');

  } catch (e) {
    var j = e && e.getJson && (function () {
      try { return e.getJson(); } catch (_) { return null; }
    })();
    var msg = (j && JSON.stringify(j)) ||
              (e && e.originalMessage) ||
              (e && e.message) || String(e);
    fail('Pull failed: ' + msg);
  }
})();

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function log(msg) {
  var t = new Date().toTimeString().slice(0, 8);
  if (msg === '') { console.log(''); return; }
  console.log('[' + t + '] ' + msg);
}

function fail(msg) {
  console.error('ERROR: ' + msg);
  process.exit(1);
}
