/**
 * qbo-pull.js - WasteNet QuickBooks Online pull
 *
 * READ-ONLY against QuickBooks. Never writes to QBO.
 *
 * Pulls three things and posts them to the Accounting Dashboard sheet:
 *
 *   Invoices  - what is owed, what is settled, and how many BOXES each
 *               invoice covers
 *   Payments  - WHEN money arrived, and against which invoice
 *
 * ---------------------------------------------------------------------
 * WHY LINE ITEMS MATTER
 *
 * An agent is paid, per box, per payment:
 *
 *     (rate - $25 cellular fee) x share
 *     share = 50% standard, 25% for Costco (Bell) and Raley's (Riley)
 *
 * That needs a box count, and the box count lives in the invoice lines -
 * one line per box. But not every line is a box. Some are one-time fees
 * (a new box, a replacement, a sensor) and those earn no commission.
 *
 * Telling them apart is the whole problem, and a survey of ~8,000 real
 * lines showed neither obvious rule works on its own:
 *
 *   - "Monitoring lines say monitoring."  84% of lines say no such
 *     thing. Costco's 4,564 box lines are bare addresses. This rule
 *     would erase most of the business.
 *
 *   - "Charges are expensive."  Charges run from $0 to $1,000, and DFW
 *     Lakes Hilton pays $850.70 for genuine monthly monitoring. The
 *     ranges overlap completely. A price threshold would misclassify
 *     real lines in both directions.
 *
 * So it takes both signals:
 *
 *   1. The description names a charge  -> CHARGE. Catches the $82 sensor
 *      and the $0 "New Box Charges" that any price rule would sail past.
 *
 *   2. Otherwise, the rate is far off THAT CUSTOMER'S OWN norm -> CHARGE.
 *      Costco bills $90 a box across thousands of lines, so an unlabelled
 *      $1,000 line is plainly a new box. DFW's $850.70 is DFW's norm, so
 *      it stays monitoring. The comparison is per customer, never global.
 *
 *   3. Otherwise -> a box.
 *
 * Anything caught by rule 2 rather than rule 1 is FLAGGED, because it was
 * inferred rather than stated. Flagged invoices are reported at the end
 * of every run. Getting this wrong changes what a person gets paid, so
 * the engine says so rather than quietly guessing.
 *
 * Sanity check: Costco's newest invoice has 244 lines, one of them a
 * $1,000 replacement. 243 boxes x ($90 - $25) x 25% = $3,948.75, which is
 * exactly the figure in the hand-built commission sheet.
 * ---------------------------------------------------------------------
 *
 * USAGE
 *   node qbo-pull.js           full run: fetch + post to the sheet
 *   node qbo-pull.js --test    fetch only, print a summary, post NOTHING
 *   node qbo-pull.js --review  print every flagged line and stop
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

var TEST_MODE   = process.argv.indexOf('--test') !== -1;
var REVIEW_MODE = process.argv.indexOf('--review') !== -1;

/* The cellular fee deducted from every box before the split. */
var CELLULAR_FEE = 25;

/* A line whose rate is this many times its customer's usual box rate is
   treated as a one-time charge even if nobody labelled it. Costco: usual
   $90, replacements $1,000 - a factor of 11. Nothing legitimate in the
   books comes close to 3x its own customer's norm. */
var OUTLIER_FACTOR = 3;

/* Words that mark a line as a one-time fee. Drawn from the real
   descriptions in the books, not invented. */
var CHARGE_WORDS = [
  'replacement', 'replace', 'new box', 'box charge', 'install',
  'installation', 'setup', 'set up', 'set-up', 'purchase', 'repair',
  'sensor', 'board', 'shipping', 'freight', 'deposit',
  'one time', 'one-time', 'onetime'
];

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
  try { fs.chmodSync(TOKENS_PATH, 0o600); } catch (e) {}
}

async function ensureFreshToken() {
  var msLeft = (tokens.access_expires_at || 0) - Date.now();
  if (msLeft > 5 * 60 * 1000) {
    log('Access token still valid (~' + Math.round(msLeft / 60000) + ' min left).');
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
/* QuickBooks                                                          */
/* ------------------------------------------------------------------ */

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

/**
 * QuickBooks caps a query at 1000 rows. Invoices are fetched with SELECT *
 * so the Line array comes too, which makes each row much heavier - hence
 * the smaller page size for them.
 */
async function queryAll(entity, fields, page) {
  var PAGE = page || 1000;
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
/* Line classification                                                 */
/* ------------------------------------------------------------------ */

function looksLikeCharge(desc) {
  var d = String(desc || '').toLowerCase();
  for (var i = 0; i < CHARGE_WORDS.length; i++) {
    if (d.indexOf(CHARGE_WORDS[i]) !== -1) return true;
  }
  return false;
}

/**
 * The rate a customer usually pays per box - the most common rate across
 * all their lines that no description marked as a charge.
 *
 * Deliberately the MODE, not the mean. A handful of $1,000 replacements
 * would drag an average upward and blunt the very comparison we need;
 * the most common value is untroubled by them.
 */
function usualRateByCustomer(invoices) {
  var counts = {};   // customer -> { rate -> howManyLines }

  invoices.forEach(function (inv) {
    var cust = (inv.CustomerRef && inv.CustomerRef.value) || '';
    (inv.Line || []).forEach(function (ln) {
      var det = ln.SalesItemLineDetail;
      if (!det || det.UnitPrice == null) return;
      if (looksLikeCharge(ln.Description)) return;   // don't let charges skew it

      var rate = Number(det.UnitPrice) || 0;
      if (rate <= 0) return;

      if (!counts[cust]) counts[cust] = {};
      counts[cust][rate] = (counts[cust][rate] || 0) + 1;
    });
  });

  var usual = {};
  Object.keys(counts).forEach(function (cust) {
    var rates = counts[cust];
    var best = null, bestN = 0, total = 0;

    Object.keys(rates).forEach(function (r) {
      total += rates[r];
      if (rates[r] > bestN) { bestN = rates[r]; best = Number(r); }
    });

    // With only a line or two to go on, "usual" means nothing. Leave it
    // undefined and let the description rule stand alone for them.
    usual[cust] = total >= 4 ? best : null;
  });

  return usual;
}

/**
 * Split one invoice's lines into boxes and one-time charges.
 * Returns { boxes, monitoring, charges, flags[] }.
 */
function classifyInvoice(inv, usualRate) {
  var cust = (inv.CustomerRef && inv.CustomerRef.value) || '';
  var usual = usualRate[cust];

  var boxes = 0;
  var monitoring = 0;
  var charges = 0;
  var flags = [];

  (inv.Line || []).forEach(function (ln) {
    var det = ln.SalesItemLineDetail;
    if (!det) return;                      // subtotal / discount lines

    var amt  = Number(ln.Amount) || 0;
    var rate = det.UnitPrice == null ? null : Number(det.UnitPrice);
    var qty  = det.Qty == null ? 1 : (Number(det.Qty) || 0);
    var desc = ln.Description || '';

    // 1. Said outright.
    if (looksLikeCharge(desc)) {
      charges += amt;
      return;
    }

    // 2. Nobody said, but the price is nothing like what this customer
    //    normally pays for a box. Inferred, so it gets flagged.
    if (usual && rate != null && rate > usual * OUTLIER_FACTOR) {
      charges += amt;
      flags.push({
        doc: inv.DocNumber || inv.Id,
        customer: (inv.CustomerRef && inv.CustomerRef.name) || '',
        rate: rate,
        usual: usual,
        desc: desc.slice(0, 60),
        why: 'rate ' + (rate / usual).toFixed(1) + 'x this customer\'s usual $' + usual
      });
      return;
    }

    // 3. A box.
    boxes += qty;
    monitoring += amt;
  });

  return { boxes: boxes, monitoring: monitoring, charges: charges, flags: flags };
}

/* ------------------------------------------------------------------ */
/* Post                                                                */
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

    var req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, function (res) {
      if (res.statusCode === 302 && res.headers.location) {
        https.get(res.headers.location, function (r2) {
          var b = '';
          r2.on('data', function (c) { b += c; });
          r2.on('end', function () { resolve(b); });
        }).on('error', reject);
        return;
      }
      var b = '';
      res.on('data', function (c) { b += c; });
      res.on('end', function () { resolve(b); });
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
    if (TEST_MODE)   log('TEST MODE - nothing will be written to the sheet.');
    if (REVIEW_MODE) log('REVIEW MODE - flagged lines only.');

    /* --- customers --- */
    log('Fetching customers...');
    var customers = await queryAll('Customer', 'Id, DisplayName');
    var nameById = {};
    customers.forEach(function (c) { nameById[String(c.Id)] = c.DisplayName; });
    log('Customers: ' + customers.length);

    /* --- invoices WITH their lines --- */
    log('Fetching invoices with line items...');
    var rawInv = await queryAll('Invoice', '*', 500);
    log('Invoices: ' + rawInv.length);

    /* --- each customer's usual box rate, for the outlier test --- */
    log('Learning each customer\'s usual box rate...');
    var usualRate = usualRateByCustomer(rawInv);

    /* --- classify --- */
    var docById = {};
    var allFlags = [];
    var totalBoxes = 0, totalCharges = 0;

    var invoices = rawInv.map(function (i) {
      var custId = i.CustomerRef && i.CustomerRef.value;
      var doc = i.DocNumber || i.Id;
      docById[String(i.Id)] = doc;

      var c = classifyInvoice(i, usualRate);
      totalBoxes += c.boxes;
      totalCharges += c.charges;
      if (c.flags.length) allFlags = allFlags.concat(c.flags);

      return {
        id:         i.Id,
        docNumber:  doc,
        txnDate:    i.TxnDate || '',
        dueDate:    i.DueDate || '',
        customer:   nameById[String(custId)] ||
                    (i.CustomerRef && i.CustomerRef.name) || '',
        total:      Number(i.TotalAmt) || 0,
        balance:    Number(i.Balance) || 0,
        boxes:      c.boxes,
        monitoring: round2(c.monitoring),
        charges:    round2(c.charges),
        review:     c.flags.length ? 'REVIEW' : ''
      };
    });

    invoices.sort(function (a, b) {
      return String(b.txnDate).localeCompare(String(a.txnDate));
    });

    /* --- flagged lines: inferred, not stated. Always shown. --- */
    if (allFlags.length) {
      log('');
      log('=== ' + allFlags.length + ' LINE(S) TREATED AS ONE-TIME CHARGES BY RATE, NOT BY LABEL ===');
      log('    Nobody wrote "replacement" on these. They were excluded because the');
      log('    price is far off what that customer normally pays for a box.');
      log('');
      allFlags.slice(0, 40).forEach(function (f) {
        log('    inv ' + pad(String(f.doc), 6) + ' ' + pad(f.customer.slice(0, 20), 21) +
            ' $' + pad(String(f.rate), 8) + f.why);
        if (f.desc) log('              "' + f.desc + '"');
      });
      if (allFlags.length > 40) log('    ... and ' + (allFlags.length - 40) + ' more');
      log('');
      log('    If any of those are real monitoring, an agent is being underpaid.');
      log('');
    } else {
      log('No inferred charges - every one-time fee was labelled. Good.');
    }

    if (REVIEW_MODE) { log('REVIEW MODE - stopping here.'); return; }

    /* --- payments --- */
    log('Fetching payments...');
    var rawPay = await queryAll('Payment', 'Id, TxnDate, TotalAmt, CustomerRef, Line');
    log('Payments: ' + rawPay.length);

    var payments = [];
    var unapplied = 0;

    rawPay.forEach(function (p) {
      var custId = p.CustomerRef && p.CustomerRef.value;
      var custName = nameById[String(custId)] ||
                     (p.CustomerRef && p.CustomerRef.name) || '';
      var linked = 0;

      (p.Line || []).forEach(function (ln) {
        (ln.LinkedTxn || []).forEach(function (t) {
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

      // No invoice link - a credit or prepayment. Kept, so the money
      // isn't lost, with a blank invoice number.
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

    /* --- summary --- */
    var open = invoices.filter(function (i) { return i.balance !== 0; });
    var owed = open.reduce(function (s, i) { return s + i.balance; }, 0);
    var collected = payments.reduce(function (s, p) { return s + p.amount; }, 0);

    log('');
    log('  Invoices:        ' + invoices.length);
    log('    open:          ' + open.length + '  ($' + owed.toFixed(2) + ' outstanding)');
    log('    paid:          ' + (invoices.length - open.length));
    log('  Box lines:       ' + totalBoxes);
    log('  One-time fees:   $' + totalCharges.toFixed(2) + '  (no commission)');
    log('  Flagged:         ' + allFlags.length + ' line(s)');
    log('  Payment rows:    ' + payments.length + '  ($' + collected.toFixed(2) + ' collected)');
    log('    unapplied:     ' + unapplied);
    log('');

    log('Newest invoices:');
    invoices.slice(0, 5).forEach(function (i) {
      log('   ' + pad(String(i.docNumber), 6) + ' ' + pad(i.customer.slice(0, 24), 25) +
          ' ' + pad(i.boxes + ' box', 8) +
          ' mon $' + pad(i.monitoring.toFixed(2), 10) +
          (i.charges ? ' chg $' + i.charges.toFixed(2) : '') +
          (i.review ? '  [REVIEW]' : ''));
    });
    log('');

    if (TEST_MODE) {
      log('TEST MODE - done. Nothing posted. Re-run without --test to write.');
      return;
    }

    log('Posting ' + invoices.length + ' invoices and ' + payments.length + ' payment rows...');
    var resp = await postToSheet(invoices, payments);
    log('Sheet replied: ' + resp);
    log('DONE.');

  } catch (e) {
    var j = e && e.getJson && (function () {
      try { return e.getJson(); } catch (_) { return null; }
    })();
    fail('Pull failed: ' + ((j && JSON.stringify(j)) ||
         (e && e.originalMessage) || (e && e.message) || String(e)));
  }
})();

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function pad(s, n) {
  s = String(s);
  while (s.length < n) s += ' ';
  return s;
}

function log(m) {
  if (m === '') { console.log(''); return; }
  console.log('[' + new Date().toTimeString().slice(0, 8) + '] ' + m);
}

function fail(m) {
  console.error('ERROR: ' + m);
  process.exit(1);
}
