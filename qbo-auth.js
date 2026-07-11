/**
 * qbo-auth.js — One-time QuickBooks Online authorization (Sandbox).
 *
 * WHY: QuickBooks uses OAuth 2.0. Before the droplet can pull any data,
 * a human has to log into QuickBooks once in a browser and approve
 * access. That approval hands back a short-lived "authorization code",
 * which this script trades for the long-lived tokens the droplet will
 * use from then on (an access token, ~1hr, and a refresh token, ~100
 * days, which auto-renews the access token).
 *
 * Because this droplet has no browser, we do it in two manual steps:
 *
 *   STEP 1 - print the auth URL:
 *       node qbo-auth.js
 *     Copy the printed URL into your Chromebox browser, log in to the
 *     sandbox, click Connect/Authorize. QuickBooks redirects to Intuit's
 *     OAuth Playground page, which shows an "Authorization Code" and a
 *     "Realm ID" (the sandbox company id). Copy both.
 *
 *   STEP 2 - exchange the code for tokens:
 *       node qbo-auth.js "<authorization_code>" "<realm_id>"
 *     This saves qbo-tokens.json. Done — the browser is never needed
 *     again; qbo-pull.js refreshes tokens on its own.
 *
 * Reads QBO_CLIENT_ID / QBO_CLIENT_SECRET / QBO_ENVIRONMENT from .env.
 * Never prints the secret. Tokens are written to qbo-tokens.json (chmod
 * 600 recommended - it's as sensitive as .env).
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const OAuthClient = require('intuit-oauth');

const TOKENS_PATH = path.join(__dirname, 'qbo-tokens.json');
const REDIRECT_URI = 'https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl';

function fail(msg) { console.error('ERROR: ' + msg); process.exit(1); }

const clientId = process.env.QBO_CLIENT_ID;
const clientSecret = process.env.QBO_CLIENT_SECRET;
const environment = (process.env.QBO_ENVIRONMENT || 'sandbox').toLowerCase();
if (!clientId || !clientSecret) fail('QBO_CLIENT_ID / QBO_CLIENT_SECRET missing from .env');

const oauthClient = new OAuthClient({
  clientId: clientId,
  clientSecret: clientSecret,
  environment: environment,        // 'sandbox' or 'production'
  redirectUri: REDIRECT_URI,
});

const authCode = process.argv[2];
const realmId = process.argv[3];

if (!authCode) {
  // STEP 1: print the authorization URL for the browser.
  const authUri = oauthClient.authorizeUri({
    scope: [OAuthClient.scopes.Accounting],   // read/write accounting; we only READ
    state: 'wastenet-' + Date.now(),          // CSRF guard, echoed back
  });
  console.log('\n=== STEP 1: Authorize in your browser ===\n');
  console.log('1. Open this URL in your Chromebox browser:\n');
  console.log(authUri);
  console.log('\n2. Log into the SANDBOX company and click Connect/Authorize.');
  console.log('3. You land on Intuit\'s OAuth Playground page. Copy two values it shows:');
  console.log('     - "Authorization Code" (a long code, often starts with "AB11...")');
  console.log('     - "Realm ID" (the sandbox company id, a long number)');
  console.log('   (They also appear in the redirected URL as ?code=...&realmId=...)');
  console.log('\n4. Then run:\n');
  console.log('     node qbo-auth.js "<authorization_code>" "<realm_id>"\n');
  process.exit(0);
}

if (!realmId) fail('Missing realm id. Usage: node qbo-auth.js "<code>" "<realm_id>"');

// STEP 2: exchange the code for tokens.
// The library's createToken wants the redirect URL with the code on it;
// we rebuild a minimal one it accepts.
const fakeRedirectUrl = REDIRECT_URI + '?code=' + encodeURIComponent(authCode) +
                        '&state=wastenet&realmId=' + encodeURIComponent(realmId);

oauthClient.createToken(fakeRedirectUrl)
  .then(function (authResponse) {
    const token = authResponse.getJson();
    const record = {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      realmId: realmId,
      environment: environment,
      // absolute expiry timestamps (ms) so qbo-pull can decide to refresh
      access_expires_at: Date.now() + (token.expires_in * 1000),
      refresh_expires_at: Date.now() + (token.x_refresh_token_expires_in * 1000),
      obtained_at: new Date().toISOString(),
    };
    fs.writeFileSync(TOKENS_PATH, JSON.stringify(record, null, 2));
    try { fs.chmodSync(TOKENS_PATH, 0o600); } catch (e) {}
    console.log('\nSUCCESS - tokens saved to qbo-tokens.json');
    console.log('  realmId:', realmId);
    console.log('  access token expires in ~', Math.round(token.expires_in / 60), 'min (auto-refreshed from here on)');
    console.log('  refresh token valid ~', Math.round(token.x_refresh_token_expires_in / 86400), 'days');
    console.log('\nNext: node qbo-pull.js  (test pull)\n');
  })
  .catch(function (e) {
    const msg = (e && e.originalMessage) || (e && e.message) || String(e);
    fail('Token exchange failed: ' + msg +
         '\n(Common causes: the code expired - they last only minutes, so run step 2 right after step 1;' +
         ' or the redirect URI in the portal doesn\'t exactly match ' + REDIRECT_URI + ')');
  });
