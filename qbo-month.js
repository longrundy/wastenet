/**
 * qbo-month.js - where is the service month, on ANY invoice?
 *
 * READ-ONLY.
 *
 * WHY
 *   Kim says she changes "the month" on each invoice. The Service Date setting
 *   is switched on. But the two invoices I have looked at - one of them a
 *   quarterly bill covering three months - have ServiceDate EMPTY and no month
 *   anywhere in the description, memo or note.
 *
 *   Rather than ask her to explain it again, look at all of them. If any
 *   invoice anywhere carries a month, this finds it, and the pattern will say
 *   which customers it applies to.
 *
 * USAGE
 *   node qbo-month.js
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
    access_token: tokens.access_token, refresh_token: tokens.refresh_token,
    token_type: 'bearer', expires_in: 3600,
    x_refresh_token_expires_in: 8726400, realmId: tokens.realmId
  }
});

var API_BASE = environment === 'production'
  ? 'https://quickbooks.api.intuit.com'
  : 'https://sandbox-quickbooks.api.intuit.com';

async function ensureFreshToken() {
  if (((tokens.access_expires_at || 0) - Date.now()) > 5 * 60 * 1000) return;
  var r = await oauthClient.refresh();
  var t = r.getJson();
  fs.writeFileSync(TOKENS_PATH, JSON.stringify({
    access_token: t.access_token, refresh_token: t.refresh_token,
    realmId: tokens.realmId, environment: environment,
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

var MONTHS = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\b/i;

(async function () {
  try {
    await ensureFreshToken();

    console.log('Reading 2026 invoices...');
    var invs = [];
    var start = 1;
    while (true) {
      var res = await query("SELECT * FROM Invoice WHERE TxnDate >= '2026-01-01' " +
                            'STARTPOSITION ' + start + ' MAXRESULTS 200');
      var batch = (res.QueryResponse && res.QueryResponse.Invoice) || [];
      invs = invs.concat(batch);
      if (batch.length < 200) break;
      start += 200;
    }
    console.log('  ' + invs.length + ' invoices');
    console.log('');

    var withServiceDate = [];
    var withMonthInDesc = [];
    var withMemo = [];
    var withNote = [];
    var totalLines = 0;
    var linesWithSvc = 0;

    invs.forEach(function (inv) {
      var doc = inv.DocNumber || '(none)';
      var cust = (inv.CustomerRef && inv.CustomerRef.name) || '?';

      if (inv.CustomerMemo && inv.CustomerMemo.value) {
        withMemo.push({ doc: doc, cust: cust, v: inv.CustomerMemo.value });
      }
      if (inv.PrivateNote) {
        withNote.push({ doc: doc, cust: cust, v: inv.PrivateNote });
      }

      (inv.Line || []).forEach(function (l) {
        var d = l.SalesItemLineDetail;
        if (!d) return;
        totalLines++;

        if (d.ServiceDate) {
          linesWithSvc++;
          withServiceDate.push({ doc: doc, cust: cust, date: d.ServiceDate,
                                 desc: String(l.Description || '').slice(0, 50) });
        }

        var desc = String(l.Description || '');
        if (MONTHS.test(desc)) {
          withMonthInDesc.push({ doc: doc, cust: cust, desc: desc.slice(0, 70) });
        }
      });
    });

    console.log('=== ServiceDate ===');
    console.log('  ' + linesWithSvc + ' of ' + totalLines + ' lines have one set');
    if (withServiceDate.length) {
      console.log('');
      var byCust = {};
      withServiceDate.forEach(function (r) {
        if (!byCust[r.cust]) byCust[r.cust] = [];
        byCust[r.cust].push(r);
      });
      Object.keys(byCust).slice(0, 12).forEach(function (c) {
        console.log('  ' + c + '  (' + byCust[c].length + ' lines)');
        byCust[c].slice(0, 3).forEach(function (r) {
          console.log('     inv ' + r.doc + '   ServiceDate=' + r.date + '   "' + r.desc + '"');
        });
      });
    } else {
      console.log('  >>> NOT ONE invoice line in 2026 has a ServiceDate.');
      console.log('  >>> The field is switched on, but nothing is being written to it.');
    }
    console.log('');

    console.log('=== A MONTH NAME IN A LINE DESCRIPTION ===');
    console.log('  ' + withMonthInDesc.length + ' line(s)');
    withMonthInDesc.slice(0, 15).forEach(function (r) {
      console.log('  inv ' + pad(r.doc, 7) + pad(r.cust.slice(0, 26), 28) + '"' + r.desc + '"');
    });
    console.log('');

    console.log('=== CUSTOMER MEMO (the customer sees this) ===');
    console.log('  ' + withMemo.length + ' invoice(s)');
    withMemo.slice(0, 12).forEach(function (r) {
      console.log('  inv ' + pad(r.doc, 7) + pad(r.cust.slice(0, 26), 28) + '"' + r.v.slice(0, 50) + '"');
    });
    console.log('');

    console.log('=== PRIVATE NOTE (internal) ===');
    console.log('  ' + withNote.length + ' invoice(s)');
    withNote.slice(0, 12).forEach(function (r) {
      console.log('  inv ' + pad(r.doc, 7) + pad(r.cust.slice(0, 26), 28) + '"' + r.v.slice(0, 50) + '"');
    });
    console.log('');

    console.log('=== READING ===');
    if (!linesWithSvc && !withMonthInDesc.length && !withMemo.length) {
      console.log('  The month is not on the invoice ANYWHERE. It exists only in the');
      console.log('  log. Which means the "Month" column is bookkeeping, not something');
      console.log('  the customer ever sees - and there is nothing to automate there.');
      console.log('');
      console.log('  Worth confirming with Kim, because it is not what she described.');
    }
  } catch (e) {
    var j = e && e.getJson && (function () { try { return e.getJson(); } catch (_) { return null; } })();
    console.error('ERROR: ' + ((j && JSON.stringify(j)) || e.message || String(e)));
    process.exit(1);
  }
})();

function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
