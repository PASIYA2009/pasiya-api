// Auth, coin charging, rate limiting and usage stats for every API call.
import { HttpError, json, sha256, stamp, CREATOR, SITE, CORS } from './util.js';
import * as fs from './firestore.js';

// ---- identity (dashboard login) ----------------------------------------
const idCache = new Map();
export async function identity(req, env) {
  const m = (req.headers.get('Authorization') || '').match(/^Bearer (.+)$/);
  if (!m) throw new HttpError(401, 'Please sign in first.');
  const hit = idCache.get(m[1]);
  if (hit && hit.exp > Date.now()) return hit.u;
  if (!env.FIREBASE_WEB_API_KEY) throw new HttpError(503, 'FIREBASE_WEB_API_KEY secret is missing.');
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_WEB_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: m[1] })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.users?.[0]) throw new HttpError(401, 'Sign-in token is invalid or expired. Sign in again.');
  const u = { uid: d.users[0].localId, email: (d.users[0].email || '').toLowerCase(), verified: !!d.users[0].emailVerified };
  if (idCache.size > 200) idCache.clear();
  idCache.set(m[1], { u, exp: Date.now() + 60_000 });
  return u;
}

// Admin = the owner's email AND that email is verified (Google login is always verified; a password
// account must verify its email first, so nobody can register the owner's address and take over).
export const isAdminEmail = (email, env, verified = true) => !!email && !!verified && email === String(env.ADMIN_EMAIL || '').toLowerCase();

export async function loadProfile(env, u) {
  let p = await fs.get(env, 'users', u.uid);
  if (!p) {
    p = { uid: u.uid, email: u.email, role: 'user', coins: 10, totalRequests: 0, createdAt: stamp(), lastDailyClaim: null, emailVerified: u.verified };
    await fs.set(env, 'users', u.uid, p);
  } else if (p.emailVerified !== u.verified || p.email !== u.email) {
    p.emailVerified = u.verified; p.email = u.email;
    await fs.commit(env, [{ merge: ['users', u.uid, { emailVerified: u.verified, email: u.email }] }]);
  }
  return p;
}

// Dashboard session: { u, p, isAdmin }
export async function session(req, env) {
  const u = await identity(req, env);
  const p = await loadProfile(env, u);
  return { u, p, isAdmin: isAdminEmail(u.email, env, u.verified) };
}

// ---- API key lookup (key doc id = sha256(key), so it is a direct read, not a query) ------
const keyCache = new Map();
export function readKey(req, url) {
  return (req.headers.get('X-API-Key') || url.searchParams.get('apikey') || url.searchParams.get('key') || '').trim();
}
async function keyOwner(env, raw) {
  const hash = await sha256(raw);
  const hit = keyCache.get(hash);
  if (hit && hit.exp > Date.now()) return hit.uid;
  let k = await fs.get(env, 'apiKeys', hash);
  if (!k) k = (await fs.query(env, 'apiKeys', 'hash', hash, 1))[0]; // keys made by the old version
  if (!k || k.revoked) throw new HttpError(401, 'Invalid or revoked API key.');
  if (keyCache.size > 500) keyCache.clear();
  keyCache.set(hash, { uid: k.uid, exp: Date.now() + 300_000 });
  return k.uid;
}
export const forgetKeys = () => keyCache.clear();

// API caller: API key (query/header) OR a dashboard login token (used by the "Test" terminal).
async function caller(req, env, url) {
  const raw = readKey(req, url);
  if (raw) {
    const uid = await keyOwner(env, raw);
    const p = await fs.get(env, 'users', uid);
    if (!p) throw new HttpError(401, 'Key owner not found.');
    return { u: { uid, email: p.email }, p, isAdmin: isAdminEmail((p.email || '').toLowerCase(), env, p.emailVerified !== false) };
  }
  if (req.headers.get('Authorization')) return session(req, env);
  throw new HttpError(401, 'API key required. Add ?apikey=YOUR_KEY or the X-API-Key header.');
}

// ---- per-user rate limit (isolate local; cheap protection against loops) ------
const bucket = new Map();
function rateLimit(uid, env) {
  const max = Number(env.RATE_LIMIT_PER_MIN || 40);
  const now = Date.now();
  let b = bucket.get(uid);
  if (!b || b.reset < now) { b = { n: 0, reset: now + 60_000 }; bucket.set(uid, b); if (bucket.size > 2000) bucket.clear(); }
  if (++b.n > max) throw new HttpError(429, `Rate limit: ${max} requests per minute. Slow down.`);
}

// ---- request parameters (query + JSON body) ----------------------------
export async function params(req, url) {
  const out = Object.fromEntries(url.searchParams);
  delete out.apikey; delete out.key;
  if (req.method === 'POST') {
    const ct = req.headers.get('content-type') || '';
    if (ct.includes('json')) {
      const text = await req.text();
      if (text.length > 20_000) throw new HttpError(413, 'Request body too large.');
      try { Object.assign(out, JSON.parse(text || '{}')); } catch { throw new HttpError(400, 'Body must be valid JSON.'); }
    }
  }
  return out;
}

// ---- stats: one atomic write per request, hourly buckets ----------------
const hourId = (d = new Date()) => 'h' + d.toISOString().slice(0, 13).replace(/\D/g, '');
async function record(env, { uid, path, status, ms, cost }) {
  const ops = [{ inc: { doc: ['stats', hourId()], by: { req: 1, err: status >= 400 ? 1 : 0, ms: Math.round(ms) } } }];
  if (status < 400 && cost > 0) {
    ops.push({ inc: { doc: ['users', uid], by: { coins: -cost, totalRequests: 1 } } });
    ops.push({ create: ['usage', { uid, endpoint: path, status: 'success', coins: cost, createdAt: stamp() }] });
  }
  try { await fs.commit(env, ops); } catch (e) { console.error('record failed', e?.message); }
}

// ---- the wrapper every public endpoint goes through -----------------------
export async function serve(req, env, ctx, def, handler) {
  const t0 = Date.now();
  const url = new URL(req.url);
  let who = null, status = 200, body;
  try {
    who = await caller(req, env, url);
    rateLimit(who.u.uid, env);
    const cost = def.cost || 0;
    if (cost > 0 && !who.isAdmin && (who.p.coins || 0) < cost) throw new HttpError(402, 'Not enough coins. Claim your daily coins, spin the wheel or ask the admin.');
    const p = await params(req, url);
    const result = await handler(p, env, req);
    body = { creator: CREATOR, success: true, website: url.origin, query: p, result };
  } catch (e) {
    status = e instanceof HttpError ? e.status : 500;
    if (!(e instanceof HttpError)) console.error(def.path, e?.stack || e);
    body = { creator: CREATOR, success: false, website: url.origin, error: e instanceof HttpError ? e.message : 'Internal error. Try again.' };
  }
  const ms = Date.now() - t0;
  if (who && env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const task = record(env, { uid: who.u.uid, path: def.path, status, ms, cost: who.isAdmin ? 0 : def.cost || 0 });
    ctx?.waitUntil ? ctx.waitUntil(task) : await task;
  }
  return json(body, status, { 'X-Response-Time': ms + 'ms' });
}

// ---- public live stats (cached) ------------------------------------------
export async function statsLast24h(env) {
  const now = Date.now();
  const ids = Array.from({ length: 24 }, (_, i) => hourId(new Date(now - i * 3600_000)));
  const docs = await fs.batchGet(env, 'stats', ids);
  let req = 0, err = 0, ms = 0;
  for (const d of docs) { req += d.req || 0; err += d.err || 0; ms += d.ms || 0; }
  return { requests: req, errors: err, avgMs: req ? Math.round(ms / req) : 0, successRate: req ? Math.round(((req - err) / req) * 1000) / 10 : 100 };
}
export { SITE, CORS };
