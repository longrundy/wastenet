/**
 * qbo-pull.js — Read QuickBooks Online data using the saved tokens.
 *
 * This is the ongoing worker (the browser is never needed again). It:
 *   1. loads qbo-tokens.json,
 *   2. refreshes the access token if it's near expiry (using the
 *      refresh token, silently),
 *   3. runs a couple of test queries and prints a summary.
 *
 * For now this only READS and PRINTS - it does not write to the sheet
 * yet (that's the next step once we see real data flowing). Run:
 *     node qbo-pull.js
 *
 * QuickBooks reads are done with the Query endpoint (SQL-like). We pull
 * a few Customers and Invoices to prove the pipe works.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const OAuthClient = require('intuit-oauth');

const TOKENS_PATH = path.join(__dirname, 'qbo-tokens.json');

function fail(msg) { console.error('ERROR: ' + msg); process.exit(1); }
function log(msg) { console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + msg); }

if (!fs.existsSync(TOKENS_PATH)) fail('qbo-tokens.json not found - run qbo-auth.js first to connect.');
const tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));

const clientId = process.env.QBO_CLIENT_ID;
const clientSecret = process.env.QBO_CLIENT_SECRET;
const environment = (tokens.environment || process.env.QBO_ENVIRONMENT || 'sandbox').toLowerCase();
if (!clientId || !clientSecret) fail('QBO_CLIENT_ID / QBO_CLIENT_SECRET missing from .env');

const oauthClient = new OAuthClient({
  clientId: clientId,
  clientSecret: clientSecret,
  environment: environment,
  redirectUri: 'https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl',
});

// Seed the client with the tokens we already have.
oauthClient.setToken({
  access_token: tokens.access_token,
  refresh_token: tokens.refresh_token,
  realmId: tokens.realmId,
  token_type: 'bearer',
  expires_in: Math.max(0, Math.round((tokens.access_expires_at - Date.now()) / 1000)),
  x_refresh_token_expires_in: Math.max(0, Math.round((tokens.refresh_expires_at - Date.now()) / 1000)),
});

// The QuickBooks API base differs by environment.
const API_BASE = environment === 'production'
  ? 'https://quickbooks.api.intuit.com'
  : 'https://sandbox-quickbooks.api.intuit.com';

function saveTokens(t) {
  const record = {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    realmId: tokens.realmId,
    environment: environment,
    access_expires_at: Date.now() + (t.expires_in * 1000),
    refresh_expires_at: Date.now() + (t.x_refresh_token_expires_in * 1000),
    obtained_at: new Date().toISOString(),
  };
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(record, null, 2));
  try { fs.chmodSync(TOKENS_PATH, 0o600); } catch (e) {}
}

async function ensureFreshToken() {
  // Refresh if the access token expires within the next 5 minutes.
  const msLeft = tokens.access_expires_at - Date.now();
  if (msLeft > 5 * 60 * 1000) {
    log('Access token still valid (~' + Math.round(msLeft / 60000) + ' min left).');
    return;
  }
  log('Access token near/at expiry - refreshing...');
  const r = await oauthClient.refresh();
  const t = r.getJson();
  saveTokens(t);
  tokens.access_token = t.access_token;
  tokens.refresh_token = t.refresh_token;
  tokens.access_expires_at = Date.now() + (t.expires_in * 1000);
  log('Refreshed OK.');
}

async function query(sql) {
  const url = API_BASE + '/v3/company/' + tokens.realmId +
              '/query?query=' + encodeURIComponent(sql) + '&minorversion=73';
  const resp = await oauthClient.makeApiCall({ url: url, method: 'GET',
    headers: { Accept: 'application/json' } });
  // The library returns the parsed body on resp.json; older/newer builds
  // may expose it via getJson() or as a raw string on resp.body/resp.text.
  if (resp.json) return resp.json;
  if (typeof resp.getJson === 'function') return resp.getJson();
  const raw = resp.body || resp.text || resp.data;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

(async function main() {
  try {
    await ensureFreshToken();

    log('Connected to ' + environment + ' company realmId=' + tokens.realmId);

    // --- Test 1: company info (proves auth + realm are right) ---
    const info = await query('SELECT * FROM CompanyInfo');
    const company = info.QueryResponse && info.QueryResponse.CompanyInfo && info.QueryResponse.CompanyInfo[0];
    if (company) log('Company: ' + company.CompanyName);

    // --- Test 2: a few customers ---
    const custs = await query('SELECT Id, DisplayName FROM Customer MAXRESULTS 5');
    const cList = (custs.QueryResponse && custs.QueryResponse.Customer) || [];
    log('Customers (showing up to 5 of them):');
    cList.forEach(function (c) { console.log('    #' + c.Id + '  ' + c.DisplayName); });

    // --- Test 3: a few invoices ---
    const invs = await query('SELECT Id, DocNumber, TxnDate, TotalAmt, Balance FROM Invoice MAXRESULTS 5');
    const iList = (invs.QueryResponse && invs.QueryResponse.Invoice) || [];
    log('Invoices (showing up to 5 of them):');
    iList.forEach(function (i) {
      const paid = Number(i.Balance) === 0 ? 'PAID' : ('owes ' + i.Balance);
      console.log('    Inv ' + (i.DocNumber || i.Id) + '  ' + i.TxnDate +
                  '  total $' + i.TotalAmt + '  [' + paid + ']');
    });

    log('DONE - QuickBooks read pipe is working.');
  } catch (e) {
    const j = e && e.getJson && (function(){ try { return e.getJson(); } catch(_) { return null; } })();
    const msg = (j && JSON.stringify(j)) || (e && e.originalMessage) || (e && e.message) || String(e);
    fail('Pull failed: ' + msg);
  }
})();
