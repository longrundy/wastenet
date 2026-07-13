/**
 * qbo-recurring.js - what recurring invoice templates actually exist?
 *
 * READ-ONLY. Writes nothing to QuickBooks, nothing to the sheet.
 *
 * WHY
 *   I was about to build a CSV export that would create 55 invoices from
 *   scratch, on the assumption that each one is typed by hand every month.
 *   That assumption may be wrong: QuickBooks Online has recurring templates,
 *   and if they exist, the line items - all 243 of Costco's - are already
 *   sitting in them. Clicking "Use" populates the invoice.
 *
 *   If that is how billing already works, then a CSV import would not save
 *   any typing. It would BYPASS the templates and create parallel invoices
 *   with none of their structure. That is a step backwards dressed up as
 *   automation.
 *
 *   So: look, rather than assume. This lists every template, what type it is,
 *   who it bills, and what is on it - then says which of the 55 customers on
 *   the billing map have no template at all.
 *
 * USAGE
 *   node qbo-recurring.js
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

/* The 55 customers currently billed, from the Billing Map seed. Used only to
   say which ones have no template - not to change anything. */
var BILLED = [
  '4 Houston Center', 'Bama Foods', 'Baycare Trilogy Medwaste', 'Brookfield Properties',
  "Carrabba's", 'Concote Corp', 'Costco Inc', 'DFW Lakes Hilton', 'Dignity Health',
  'East Jordan Iron Works', 'Five Oaks Place', 'Four Oaks Place', 'Frito Lay York',
  'Gaylord Texan Resort', 'General Mills/Pillsbury', 'General Mills/ Yoplait',
  'Great Wolf Lodge', 'Greenway Plaza', 'Gulf State Toyota-VPC', 'Haldor Topsoe',
  'Hilton Palacio Del Rio', 'Houston Zoo', 'Hyatt Regency Galleria/WCA',
  'International Paper', 'Kindred Hospital/Republic Services', 'Lifeway Christian',
  'LPF Greenway Commons,LLC', 'Marriott IAH', 'Marriott Galleria',
  'Memorial Hermann Memorial City Med. Ctr.', 'MetroNational',
  'Nabors Property Holdings, LLC', 'North Cypress', 'Pioneer Flour Mill',
  'Post  Oak', 'Post Oak - 1700', 'Post Oak Hotel',
  "Raley's Family of Fine Stores (Bel Air)", "Raley's Family of Fine Foods",
  "Raley's Family of Fine Stores Nob Hill", 'Rice Village', "Rich's Products",
  'Riviera Country Club', 'Silver Eagle', 'SPM Oil & Gas a Caterpillar Company',
  'SPX Corporation', 'Saint Catherine Hospital', 'Teleplan', 'Texas Childrens Hospital',
  'US Remodelers /Home Depot', 'US Postal Service Nashville', 'US Postal Service /Denver',
  'US Postal Service / Melville', 'Westin', 'WNJ Regional Hospital'
];

(async function () {
  try {
    await ensureFreshToken();

    log('Reading recurring transaction templates...');
    log('');

    var res = await query('SELECT * FROM RecurringTransaction MAXRESULTS 500');
    var items = (res.QueryResponse && res.QueryResponse.RecurringTransaction) || [];

    if (!items.length) {
      log('=== NO RECURRING TEMPLATES AT ALL ===');
      log('');
      log('  Every invoice is being built by hand each month. In that case a');
      log('  bulk import would genuinely save the typing, and is worth building.');
      return;
    }

    /* Only invoice templates matter here. */
    var invoices = items.filter(function (i) { return !!i.Invoice; });

    log('=== ' + items.length + ' recurring template(s), ' +
        invoices.length + ' of them invoices ===');
    log('');

    var byType = {};
    var covered = {};
    var rows = [];

    invoices.forEach(function (it) {
      var inv = it.Invoice;
      var ri = (inv.RecurringInfo) || {};
      var type = ri.RecurType || '(none)';
      var name = ri.Name || '(unnamed)';
      var active = ri.Active !== false;
      var cust = (inv.CustomerRef && inv.CustomerRef.name) || '(no customer)';

      var lines = (inv.Line || []).filter(function (l) {
        return l.DetailType === 'SalesItemLineDetail';
      });

      var total = lines.reduce(function (s, l) { return s + (Number(l.Amount) || 0); }, 0);

      byType[type] = (byType[type] || 0) + 1;
      covered[cust] = true;

      rows.push({
        name: name, type: type, active: active, cust: cust,
        lines: lines.length, total: total,
        interval: ri.ScheduleInfo
          ? (ri.ScheduleInfo.IntervalType || '') + ' x' + (ri.ScheduleInfo.NumInterval || '')
          : '',
        nextDate: (ri.ScheduleInfo && ri.ScheduleInfo.NextDate) || '',
        autoSend: !!(ri.ScheduleInfo && ri.ScheduleInfo.RemindDays === 0 && type === 'Automated')
      });
    });

    log('BY TYPE:');
    Object.keys(byType).forEach(function (t) {
      var what =
        t === 'Automated' ? 'created automatically, no action needed'
        : t === 'Reminded' ? 'reminds you; you review and create it'
        : t === 'Manual'   ? 'a saved template - you hit "Use" when you want it'
        : '';
      log('  ' + pad(t, 12) + pad(String(byType[t]), 5) + what);
    });
    log('');

    rows.sort(function (a, b) { return b.lines - a.lines; });

    log('TEMPLATES (most line items first):');
    log('  ' + pad('customer', 36) + pad('type', 11) + pad('lines', 7) +
        pad('total', 12) + 'next');
    log('  ' + '-'.repeat(78));
    rows.forEach(function (r) {
      log('  ' + pad(r.cust.slice(0, 34), 36) +
          pad(r.type, 11) +
          pad(String(r.lines), 7) +
          pad('$' + r.total.toFixed(2), 12) +
          (r.nextDate || '') +
          (r.active ? '' : '   [INACTIVE]'));
    });
    log('');

    /* --- who is billed but has no template --- */
    var missing = BILLED.filter(function (c) { return !covered[c]; });

    log('=== COVERAGE ===');
    log('  billed customers:      ' + BILLED.length);
    log('  with a template:       ' + (BILLED.length - missing.length));
    log('  WITHOUT a template:    ' + missing.length);
    log('');

    if (missing.length) {
      log('  These are billed every month but have no recurring template -');
      log('  so these ARE being built by hand:');
      missing.forEach(function (c) { log('     ' + c); });
      log('');
    }

    /* --- what it means --- */
    log('=== READING ===');
    var manual = (byType.Manual || 0);
    var reminded = (byType.Reminded || 0);
    var automated = (byType.Automated || 0);

    if (automated) {
      log('  ' + automated + ' template(s) are AUTOMATED - QuickBooks creates those');
      log('  invoices on schedule with no action at all.');
    }
    if (reminded || manual) {
      log('  ' + (reminded + manual) + ' template(s) need a click ("Use", or a reminder)');
      log('  but the line items are already in them - nothing is being typed.');
    }
    if (missing.length) {
      log('  ' + missing.length + ' customer(s) have NO template. Those are the ones');
      log('  actually being built from scratch each month.');
    }
    log('');
    log('  If most customers have templates, a bulk CSV import would not save');
    log('  typing - it would bypass the templates and create invoices without');
    log('  their structure. The dashboard\'s job is then to say WHAT CHANGED,');
    log('  not to do the invoicing.');

  } catch (e) {
    var j = e && e.getJson && (function () { try { return e.getJson(); } catch (_) { return null; } })();
    console.error('ERROR: ' + ((j && JSON.stringify(j)) || e.message || String(e)));
    process.exit(1);
  }
})();

function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
function log(m) { console.log(m); }
