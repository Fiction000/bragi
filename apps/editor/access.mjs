import { createPublicKey, verify } from 'node:crypto';

// Cloudflare Access in front of the public hostname. Every request that arrives with that Host must carry
// a Cf-Access-Jwt-Assertion signed by the team (RS256), for this app's AUD, unexpired, from a human whose
// email is on the list. Service tokens (common_name, empty sub) are refused.

const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const b64json = part => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

// fetchKeys: () => Promise<{ keys: JWK[] }>. Defaults to the team's /cdn-cgi/access/certs, cached 10 min,
// refetched once when a kid is unknown (key rotation).
export function createAccessVerifier({ teamDomain, audience, emails, fetchKeys, now = () => Date.now() }) {
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(teamDomain ?? '') || !audience || !emails?.length) throw new Error('Access configuration incomplete');
  const issuer = `https://${teamDomain.toLowerCase()}`;
  const allowed = new Set(emails.map(e => e.toLowerCase()));
  const load = fetchKeys ?? (async () => {
    const res = await fetch(`${issuer}/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error(`certs ${res.status}`);
    return res.json();
  });
  let cache = { at: 0, keys: new Map() };
  const refresh = async () => {
    const { keys } = await load();
    cache = { at: now(), keys: new Map(keys.filter(k => k.kty === 'RSA' && k.kid).map(k => [k.kid, createPublicKey({ key: k, format: 'jwk' })])) };
  };
  const keyFor = async kid => {
    if (!cache.keys.has(kid) || now() - cache.at > 600_000) await refresh();
    return cache.keys.get(kid);
  };

  return async function verifyAccess(token) {
    if (typeof token !== 'string' || !JWT.test(token)) return null;
    const [h, p, s] = token.split('.');
    let header, payload;
    try { header = b64json(h); payload = b64json(p); } catch { return null; }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
    let key;
    try { key = await keyFor(header.kid); } catch { return null; }
    if (!key || !verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))) return null;
    const seconds = now() / 1000;
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (payload.iss !== issuer || !aud.includes(audience)) return null;
    if (typeof payload.exp !== 'number' || payload.exp <= seconds) return null;
    if (typeof payload.nbf === 'number' && payload.nbf > seconds + 60) return null;
    if ('common_name' in payload || typeof payload.sub !== 'string' || !payload.sub) return null;
    if (typeof payload.email !== 'string' || !allowed.has(payload.email.toLowerCase())) return null;
    return { email: payload.email.toLowerCase(), sub: payload.sub };
  };
}
