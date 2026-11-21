import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { createAccessVerifier } from '../access.mjs';
import { createEditorServer } from '../server.mjs';

const TEAM = 'team.cloudflareaccess.com';
const AUD = 'aud-123';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };
const fetchKeys = async () => ({ keys: [jwk] });
const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
function token(claims = {}, { kid = 'k1', key = privateKey, alg = 'RS256' } = {}) {
  const h = b64({ alg, kid }), p = b64({ iss: `https://${TEAM}`, aud: [AUD], sub: 'user-1', email: 'Owner@example.com', type: 'app', iat: now, exp: now + 600, ...claims });
  return `${h}.${p}.${sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url')}`;
}
const verifier = () => createAccessVerifier({ teamDomain: TEAM, audience: AUD, emails: ['owner@example.com'], fetchKeys });

test('a signed owner assertion passes; every other assertion is refused', async () => {
  const v = verifier();
  assert.deepEqual(await v(token()), { email: 'owner@example.com', sub: 'user-1' });
  const refused = {
    'no token': undefined,
    garbage: 'a.b',
    'other key': token({}, { key: other.privateKey }),
    'unknown kid': token({}, { kid: 'k2' }),
    'alg none': token({}, { alg: 'none' }),
    'wrong aud': token({ aud: ['x'] }),
    'wrong issuer': token({ iss: 'https://evil.cloudflareaccess.com' }),
    expired: token({ exp: now - 1 }),
    'no exp': token({ exp: undefined }),
    'other email': token({ email: 'someone@example.com' }),
    'service token': token({ sub: '', common_name: 'client.access', email: undefined }),
    'common_name with owner email': token({ common_name: 'client.access' }),
  };
  for (const [name, t] of Object.entries(refused)) assert.equal(await v(t), null, name);
});

test('incomplete Access settings are refused at start', () => {
  assert.throws(() => createAccessVerifier({ teamDomain: TEAM, audience: '', emails: ['a@b.c'] }), /incomplete/);
  assert.throws(() => createAccessVerifier({ teamDomain: TEAM, audience: AUD, emails: [] }), /incomplete/);
});

async function publicServer() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'wle-access-'));
  await cp(path.resolve('test/fixtures/run'), path.join(tmp, 'run'), { recursive: true });
  const server = await createEditorServer({ run: path.join(tmp, 'run'), port: 0, publicHost: 'cms.example.dev', verifyAccess: verifier() });
  const port = server.address().port;
  const request = (method, url, headers, body) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: url, method, headers }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body);
  });
  return { server, port, request, close: async () => { await new Promise(r => server.close(r)); await rm(tmp, { recursive: true, force: true }); } };
}

test('the public host needs Access on every request, reads and writes alike; loopback is unchanged', async () => {
  const t = await publicServer();
  try {
    const pub = { host: 'cms.example.dev' };
    assert.equal((await t.request('GET', '/', pub)).status, 403);
    assert.equal((await t.request('GET', '/api/drafts/kawazoi', pub)).status, 403);
    assert.equal((await t.request('GET', '/api/drafts/kawazoi', { ...pub, 'cf-access-jwt-assertion': token({ email: 'x@example.com' }) })).status, 403);
    const ok = { ...pub, 'cf-access-jwt-assertion': token() };
    const draft = await t.request('GET', '/api/drafts/kawazoi', ok);
    assert.equal(draft.status, 200);
    const { state, revision } = JSON.parse(draft.body);
    const body = JSON.stringify({ state, baseRevision: revision });
    // write: https Origin of the public host only
    assert.equal((await t.request('PUT', '/api/drafts/kawazoi', { ...ok, origin: 'http://cms.example.dev', 'content-type': 'application/json' }, body)).status, 403);
    assert.equal((await t.request('PUT', '/api/drafts/kawazoi', { ...ok, origin: 'https://evil.dev', 'content-type': 'application/json' }, body)).status, 403);
    assert.equal((await t.request('PUT', '/api/drafts/kawazoi', { ...pub, origin: 'https://cms.example.dev', 'content-type': 'application/json' }, body)).status, 403);
    assert.equal((await t.request('PUT', '/api/drafts/kawazoi', { ...ok, origin: 'https://cms.example.dev', 'content-type': 'application/json' }, body)).status, 200);
    // other hosts are still refused, loopback still works without Access
    assert.equal((await t.request('GET', '/api/drafts/kawazoi', { host: 'evil.dev', 'cf-access-jwt-assertion': token() })).status, 403);
    assert.equal((await t.request('GET', '/api/drafts/kawazoi', { host: `127.0.0.1:${t.port}` })).status, 200);
  } finally { await t.close(); }
});

test('--public-host without Access settings does not start', async () => {
  await assert.rejects(createEditorServer({ run: path.resolve('test/fixtures/run'), port: 0, publicHost: 'cms.example.dev' }), /Access settings/);
});
