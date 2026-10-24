// Google and Apple sign-in: verifies the ID token the app receives from Google Identity Services or
// Sign in with Apple (RS256 signature against the provider's published keys, issuer, audience, expiry).
import crypto from 'node:crypto';
import { fail } from './errors.js';

const PROVIDERS = {
  google: { jwks: 'https://www.googleapis.com/oauth2/v3/certs', iss: ['https://accounts.google.com', 'accounts.google.com'], aud: () => process.env.GOOGLE_CLIENT_ID },
  apple: { jwks: 'https://appleid.apple.com/auth/keys', iss: ['https://appleid.apple.com'], aud: () => process.env.APPLE_CLIENT_ID },
};
const keyCache = {};
async function keysFor(provider) {
  const c = keyCache[provider];
  if (c && c.exp > Date.now()) return c.keys;
  const r = await fetch(PROVIDERS[provider].jwks);
  if (!r.ok) fail(503, 'Sign-in is unavailable right now. Try again shortly.');
  const { keys } = await r.json();
  keyCache[provider] = { keys, exp: Date.now() + 3600e3 };
  return keys;
}
const part = s => JSON.parse(Buffer.from(s, 'base64url').toString());

async function verifyWithProvider(provider, idToken) {
  const P = PROVIDERS[provider];
  if (!P) fail(400, 'Unknown sign-in provider.');
  const aud = P.aud();
  if (!aud) fail(503, `${provider === 'google' ? 'Google' : 'Apple'} sign-in isn't set up on this server yet.`, 'oauth_unconfigured');
  const [h, b, sig] = String(idToken || '').split('.');
  if (!h || !b || !sig) fail(401, 'Sign-in could not be verified.', 'oauth_invalid');
  const head = part(h), body = part(b);
  const jwk = head.alg === 'RS256' && (await keysFor(provider)).find(k => k.kid === head.kid);
  const ok = jwk && crypto.verify('RSA-SHA256', Buffer.from(`${h}.${b}`), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(sig, 'base64url'));
  if (!ok || !P.iss.includes(body.iss) || body.aud !== aud || body.exp * 1000 < Date.now()) fail(401, 'Sign-in could not be verified.', 'oauth_invalid');
  return { sub: String(body.sub), email: body.email || null, emailVerified: body.email_verified === true || body.email_verified === 'true', name: body.name || null };
}

let verifier = verifyWithProvider;
export const verifyIdToken = (provider, idToken) => verifier(provider, idToken);
// Tests replace the network check with a fake.
export function setOAuthVerifier(fn) { verifier = fn || verifyWithProvider; }
