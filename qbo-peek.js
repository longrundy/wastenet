/**
 * qbo-peek.js - look at one invoice's line items.
 *
 * Diagnostic only. Read-only. Nothing is written anywhere.
 *
 *   node qbo-peek.js            newest invoice
 *   node qbo-peek.js 6063       that invoice number
 *   node qbo-peek.js --customer Costco    newest invoice for a customer
 *
 * The point is to find out whether QuickBooks invoice lines carry a box
 * quantity and a rate. If they do, box counts never have to be typed in
 * by hand - they can be read straight off the invoice that was billed.
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

(async function () {
  try {
    await ensureFreshToken();

    var args = process.argv.slice(2);
    var sql;

    if (args[0] === '--customer' && args[1]) {
      var custRes = await query(
        "SELECT Id, DisplayName FROM Customer WHERE DisplayName LIKE '%" + args[1] + "%'"
      );
      var custs = (custRes.QueryResponse && custRes.QueryResponse.Customer) || [];
      if (!custs.length) { console.log('No customer matching: ' + args[1]); return; }
      console.log('Customer: ' + custs[0].DisplayName + ' (id ' + custs[0].Id + ')\n');
      sql = "SELECT * FROM Invoice WHERE CustomerRef = '" + custs[0].Id +
            "' ORDERBY TxnDate DESC MAXRESULTS 1";
    } else if (args[0]) {
      sql = "SELECT * FROM Invoice WHERE DocNumber = '" + args[0] + "'";
    } else {
      sql = "SELECT * FROM Invoice ORDERBY TxnDate DESC MAXRESULTS 1";
    }

    var res = await query(sql);
    var invs = (res.QueryResponse && res.QueryResponse.Invoice) || [];
    if (!invs.length) { console.log('No invoice found.'); return; }

    var inv = invs[0];

    console.log('=== INVOICE ' + (inv.DocNumber || inv.Id) + ' ===');
    console.log('  customer : ' + (inv.CustomerRef && inv.CustomerRef.name));
    console.log('  date     : ' + inv.TxnDate);
    console.log('  total    : $' + inv.TotalAmt);
    console.log('  balance  : $' + inv.Balance);
    console.log('');
    console.log('=== LINES (' + (inv.Line || []).length + ') ===');
    console.log(JSON.stringify(inv.Line, null, 2));

    // The bit that actually matters: is there a quantity per line?
    console.log('');
    console.log('=== READING (what we could use) ===');
    var boxes = 0, any = false;
    (inv.Line || []).forEach(function (ln) {
      var d = ln.SalesItemLineDetail;
      if (!d) return;
      any = true;
      var qty  = d.Qty;
      var rate = d.UnitPrice;
      var item = d.ItemRef && d.ItemRef.name;
      if (qty != null) boxes += Number(qty) || 0;
      console.log('  item=' + item +
                  '  qty=' + (qty == null ? '(none)' : qty) +
                  '  rate=' + (rate == null ? '(none)' : '$' + rate) +
                  '  amount=$' + ln.Amount +
                  '  desc="' + String(ln.Description || '').slice(0, 50) + '"');
    });
    console.log('');
    if (!any) {
      console.log('  No SalesItemLineDetail on any line - quantities are not stored this way.');
    } else if (boxes) {
      console.log('  TOTAL QTY ON THIS INVOICE: ' + boxes);
      console.log('  If that is the box count, cellular fee = ' + boxes + ' x $25 = $' + (boxes * 25));
    } else {
      console.log('  Lines exist but carry no Qty - box counts are not on the invoice.');
    }

  } catch (e) {
    var j = e && e.getJson && (function () {
      try { return e.getJson(); } catch (_) { return null; }
    })();
    console.error('ERROR: ' + ((j && JSON.stringify(j)) || e.message || String(e)));
  }
})();
