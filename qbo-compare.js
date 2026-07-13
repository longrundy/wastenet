/**
 * qbo-compare.js - what exactly does she change on each invoice?
 *
 * READ-ONLY. Writes nothing.
 *
 * WHY
 *   QuickBooks auto-creates 54 invoices a month from recurring templates. She
 *   then opens every one and corrects the same handful of fields: the invoice
 *   number, the service month, the box count if CES has changed, and any
 *   one-time fee.
 *
 *   That is ~200 mechanical edits a month, and every one of them is derivable
 *   from data the dashboard already holds. So it is a candidate for the API -
 *   not CREATING invoices, which would be risky, but UPDATING fields on
 *   invoices that already exist. Far smaller blast radius.
 *
 *   But only if we know EXACTLY where each thing lives. Is the service month
 *   in the memo? A line description? A custom field? Guessing wrong means
 *   writing to the wrong field on real invoices, and that is not a mistake
 *   worth making twice.
 *
 *   So: put an untouched invoice next to a corrected one, and print every
 *   field of both. The difference is the answer.
 *
 * USAGE
 *   node qbo-compare.js 6164 6124
 *      6164 = untouched (as QuickBooks generated it)
 *      6124 = corrected  (as she finished it - June's Costco, say)
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

function show(label, inv) {
  console.log('');
  console.log('================================================================');
  console.log(label + '  -  invoice ' + (inv.DocNumber || '(no number)'));
  console.log('================================================================');
  console.log('  Id (internal):   ' + inv.Id);
  console.log('  DocNumber:       ' + (inv.DocNumber || '-'));
  console.log('  Customer:        ' + ((inv.CustomerRef && inv.CustomerRef.name) || '-'));
  console.log('  TxnDate:         ' + (inv.TxnDate || '-'));
  console.log('  DueDate:         ' + (inv.DueDate || '-'));
  console.log('  Total:           $' + (inv.TotalAmt || 0));
  console.log('  Balance:         $' + (inv.Balance || 0));
  console.log('');
  console.log('  --- fields the service MONTH could live in ---');
  console.log('  CustomerMemo:    ' + ((inv.CustomerMemo && inv.CustomerMemo.value) || '(empty)'));
  console.log('  PrivateNote:     ' + (inv.PrivateNote || '(empty)'));
  console.log('  DocNumber:       ' + (inv.DocNumber || '(empty)'));

  if (inv.CustomField && inv.CustomField.length) {
    inv.CustomField.forEach(function (c) {
      console.log('  CustomField "' + (c.Name || '?') + '": ' + (c.StringValue || '(empty)'));
    });
  } else {
    console.log('  CustomField:     (none)');
  }

  console.log('  EmailStatus:     ' + (inv.EmailStatus || '-'));
  console.log('  Sent:            ' + (inv.EmailStatus === 'EmailSent' ? 'YES' : 'no'));

  var lines = (inv.Line || []).filter(function (l) {
    return l.DetailType === 'SalesItemLineDetail';
  });

  console.log('');
  console.log('  --- ' + lines.length + ' line item(s) ---');
  lines.slice(0, 8).forEach(function (l, i) {
    var d = l.SalesItemLineDetail || {};
    console.log('   ' + String(i + 1).padStart(3) + '. $' +
                String(l.Amount || 0).padEnd(10) +
                'qty=' + String(d.Qty == null ? '-' : d.Qty).padEnd(5) +
                'rate=' + String(d.UnitPrice == null ? '-' : d.UnitPrice).padEnd(8) +
                'item=' + ((d.ItemRef && d.ItemRef.name) || '-'));

    /* THE FIELD THAT MATTERS.
     *
     * The service month lives here. My first pass printed the description,
     * the quantity, the rate and the item - everything EXCEPT the one field
     * I had been told to look at. */
    console.log('        ServiceDate:  ' + (d.ServiceDate || '(EMPTY)'));

    // Full description, untruncated - the month may be in here too.
    console.log('        Description:  "' + String(l.Description || '') + '"');
  });
  if (lines.length > 8) console.log('   ... and ' + (lines.length - 8) + ' more');
}

(async function () {
  try {
    var a = process.argv[2];
    var b = process.argv[3];
    if (!a) {
      console.error('usage: node qbo-compare.js <untouched-invoice#> [corrected-invoice#]');
      process.exit(1);
    }

    await ensureFreshToken();

    var r1 = await query("SELECT * FROM Invoice WHERE DocNumber = '" + a + "'");
    var i1 = (r1.QueryResponse && r1.QueryResponse.Invoice && r1.QueryResponse.Invoice[0]);
    if (!i1) { console.error('No invoice ' + a); process.exit(1); }
    show('AS QUICKBOOKS GENERATED IT (untouched)', i1);

    if (b) {
      var r2 = await query("SELECT * FROM Invoice WHERE DocNumber = '" + b + "'");
      var i2 = (r2.QueryResponse && r2.QueryResponse.Invoice && r2.QueryResponse.Invoice[0]);
      if (i2) show('AFTER SHE CORRECTED IT', i2);
    }

    console.log('');
    console.log('=== WHAT TO LOOK FOR ===');
    console.log('  Where does the SERVICE MONTH appear? Memo, private note, a line');
    console.log('  description, a custom field? That is the field an update has to');
    console.log('  write to - and the one thing worth being certain about before');
    console.log('  anything writes to a real invoice.');
  } catch (e) {
    var j = e && e.getJson && (function () { try { return e.getJson(); } catch (_) { return null; } })();
    console.error('ERROR: ' + ((j && JSON.stringify(j)) || e.message || String(e)));
    process.exit(1);
  }
})();
