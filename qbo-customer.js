/**
 * qbo-customer.js - one customer's ledger, invoices against payments.
 *
 * Diagnostic only. READ-ONLY. Nothing is written to QuickBooks, nothing to
 * the sheet, nothing to disk (bar the token refresh every one of these
 * scripts does).
 *
 *   node qbo-customer.js "Costco Inc"
 *   node qbo-customer.js "Costco Inc" 2026-01-01 2026-07-01
 *   node qbo-customer.js "International Paper"
 *   node qbo-customer.js --list                 every customer name
 *
 * WHY THIS EXISTS
 *
 * The Deposits page flagged three deposits it could not explain: $21,870
 * from Costco on 3 June, and $275 from International Paper twice. Money
 * arrived, and the books show no payment recorded near that date and no open
 * invoice that adds up to it.
 *
 * Costco's ACH deposits over six months were:
 *
 *     21,420.00   21,870.00   22,191.33   22,206.56   23,420.00   24,780.00
 *
 * Two of those carry cents. Every invoice WasteNet raises is a round number
 * of dollars. So something is being deducted before the money arrives - and
 * this is the largest account in the business, $135,888 a year, 62% of all
 * the ACH money that comes in.
 *
 * Guessing at that from the bank side is pointless. The answer is in the
 * ledger: what was invoiced, what was paid against it, and what the
 * difference is. So print exactly that, in date order, and let the numbers
 * speak.
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

async function queryAll(entity, where) {
  var out = [], start = 1, page = 1000;
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
function money(n) {
  var v = Number(n) || 0;
  return (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
/* Money is compared as integer cents. 0.1 + 0.2 !== 0.3, and a rounding
   error in a reconciliation is how you end up chasing a penny for an hour. */
function cents(n) { return Math.round((Number(n) || 0) * 100); }

(async function () {
  try {
    await ensureFreshToken();

    var args = process.argv.slice(2);

    if (args[0] === '--list') {
      var all = await queryAll('Customer');
      all.map(function (c) { return c.DisplayName; }).sort().forEach(function (n) {
        console.log('   ' + n);
      });
      console.log('\n' + all.length + ' customers.');
      return;
    }

    var name = args[0];
    if (!name) {
      console.log('Which customer?  node qbo-customer.js "Costco Inc"');
      console.log('                 node qbo-customer.js --list');
      return;
    }
    var from = args[1] || '2026-01-01';
    var to   = args[2] || '2026-12-31';

    /* --- find the customer --- */
    var esc = name.replace(/'/g, "\\'");
    var cres = await query("SELECT Id, DisplayName FROM Customer WHERE DisplayName LIKE '%" + esc + "%'");
    var custs = (cres.QueryResponse && cres.QueryResponse.Customer) || [];
    if (!custs.length) { console.log('No customer matching: ' + name); return; }
    if (custs.length > 1) {
      console.log('Several customers match "' + name + '":');
      custs.forEach(function (c) { console.log('   ' + c.DisplayName); });
      console.log('\nBe more specific.');
      return;
    }
    var cust = custs[0];
    console.log('=== ' + cust.DisplayName + ' ===');
    console.log('    ' + from + '  to  ' + to + '\n');

    /* --- invoices and payments --- */
    var invs = await queryAll('Invoice',
      "CustomerRef = '" + cust.Id + "' AND TxnDate >= '" + from + "' AND TxnDate <= '" + to + "'");
    var pays = await queryAll('Payment',
      "CustomerRef = '" + cust.Id + "' AND TxnDate >= '" + from + "' AND TxnDate <= '" + to + "'");

    var invById = {};
    invs.forEach(function (i) { invById[String(i.Id)] = i; });

    /* --- the ledger, in date order --- */
    var events = [];
    invs.forEach(function (i) {
      events.push({
        date: i.TxnDate, kind: 'INVOICE',
        doc: i.DocNumber || i.Id,
        amount: Number(i.TotalAmt) || 0,
        balance: Number(i.Balance) || 0
      });
    });
    pays.forEach(function (p) {
      var applied = [];
      (p.Line || []).forEach(function (ln) {
        (ln.LinkedTxn || []).forEach(function (t) {
          if (t.TxnType !== 'Invoice') return;
          var iv = invById[String(t.TxnId)];
          applied.push({
            doc: iv ? (iv.DocNumber || iv.Id) : t.TxnId,
            amount: Number(ln.Amount) || 0,
            invTotal: iv ? (Number(iv.TotalAmt) || 0) : null
          });
        });
      });
      events.push({
        date: p.TxnDate, kind: 'PAYMENT',
        amount: Number(p.TotalAmt) || 0,
        unapplied: Number(p.UnappliedAmt) || 0,
        applied: applied,
        method: (p.PaymentMethodRef && p.PaymentMethodRef.name) || '(not set)'
      });
    });
    events.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return a.kind === 'INVOICE' ? -1 : 1;   // invoice before the payment that clears it
    });

    console.log('=== LEDGER ===');
    console.log('   ' + pad('DATE', 12) + pad('', 9) + pad('DOC', 8) +
                padL('AMOUNT', 13) + '   DETAIL');
    console.log('   ' + '-'.repeat(96));

    events.forEach(function (e) {
      if (e.kind === 'INVOICE') {
        var open = e.balance > 0 ? '  OPEN  ' + money(e.balance) + ' still owed' : '  paid';
        console.log('   ' + pad(e.date, 12) + pad('invoice', 9) + pad('#' + e.doc, 8) +
                    padL(money(e.amount), 13) + open);
      } else {
        var det = e.applied.length
          ? e.applied.map(function (a) {
              var short = (a.invTotal != null && cents(a.amount) !== cents(a.invTotal))
                ? ' (invoice was ' + money(a.invTotal) + ' \u2014 SHORT ' +
                  money(a.invTotal - a.amount) + ')'
                : '';
              return '#' + a.doc + ' ' + money(a.amount) + short;
            }).join(', ')
          : 'NOT APPLIED TO ANY INVOICE';
        if (e.unapplied) det += '   [' + money(e.unapplied) + ' unapplied]';
        console.log('   ' + pad(e.date, 12) + pad('PAYMENT', 9) + pad('', 8) +
                    padL(money(e.amount), 13) + '   ' + det);
      }
    });

    /* --- does it add up? --- */
    var totInv = invs.reduce(function (s, i) { return s + (Number(i.TotalAmt) || 0); }, 0);
    var totPay = pays.reduce(function (s, p) { return s + (Number(p.TotalAmt) || 0); }, 0);
    var openBal = invs.reduce(function (s, i) { return s + (Number(i.Balance) || 0); }, 0);

    console.log('\n=== DOES IT ADD UP? ===');
    console.log('   invoiced in this window : ' + padL(money(totInv), 14) + '  (' + invs.length + ' invoices)');
    console.log('   paid in this window     : ' + padL(money(totPay), 14) + '  (' + pays.length + ' payments)');
    console.log('   still open              : ' + padL(money(openBal), 14));
    console.log('   invoiced - paid - open  : ' + padL(money(totInv - totPay - openBal), 14) +
                '   <- should be zero if nothing odd is happening');

    /* --- the short-pays, gathered ---
       This is the whole reason the script exists. A payment that settles an
       invoice for LESS than the invoice was for is either a deduction the
       customer is making, or an error. Either way it is money you do not
       have, and nobody is looking at it. */
    var shorts = [];
    pays.forEach(function (p) {
      (p.Line || []).forEach(function (ln) {
        (ln.LinkedTxn || []).forEach(function (t) {
          if (t.TxnType !== 'Invoice') return;
          var iv = invById[String(t.TxnId)];
          if (!iv) return;
          var paid = Number(ln.Amount) || 0;
          var full = Number(iv.TotalAmt) || 0;
          if (cents(paid) < cents(full)) {
            shorts.push({
              date: p.TxnDate,
              doc: iv.DocNumber || iv.Id,
              invoiced: full, paid: paid, gap: full - paid
            });
          }
        });
      });
    });

    console.log('\n=== SHORT PAYMENTS ===');
    if (!shorts.length) {
      console.log('   None. Every invoice was paid in full.');
    } else {
      console.log('   An invoice settled for LESS than it was raised for. The customer is');
      console.log('   deducting something, or somebody keyed it wrong. Either way it is');
      console.log('   money that never arrived.\n');
      console.log('   ' + pad('DATE', 12) + pad('DOC', 8) + padL('INVOICED', 13) +
                  padL('PAID', 13) + padL('SHORT BY', 13));
      console.log('   ' + '-'.repeat(60));
      var gap = 0;
      shorts.forEach(function (s) {
        gap += s.gap;
        console.log('   ' + pad(s.date, 12) + pad('#' + s.doc, 8) +
                    padL(money(s.invoiced), 13) + padL(money(s.paid), 13) +
                    padL(money(s.gap), 13));
      });
      console.log('   ' + '-'.repeat(60));
      console.log('   ' + pad('', 20) + padL('', 13) + padL('TOTAL SHORT', 13) + padL(money(gap), 13));
    }

    /* --- payments that hit no invoice at all --- */
    var floating = pays.filter(function (p) {
      var linked = 0;
      (p.Line || []).forEach(function (ln) {
        (ln.LinkedTxn || []).forEach(function (t) { if (t.TxnType === 'Invoice') linked++; });
      });
      return linked === 0;
    });
    if (floating.length) {
      console.log('\n=== PAYMENTS APPLIED TO NOTHING ===');
      console.log('   Money received but not linked to any invoice. The invoice stays open');
      console.log('   and looks unpaid, while the money sits as a credit.\n');
      floating.forEach(function (p) {
        console.log('   ' + pad(p.TxnDate, 12) + padL(money(p.TotalAmt), 13));
      });
    }

  } catch (err) {
    console.error('ERROR: ' + (err && err.message ? err.message : String(err)));
    if (err && err.authResponse) {
      try { console.error(JSON.stringify(err.authResponse.json, null, 2)); } catch (e) {}
    }
    process.exit(1);
  }
})();
