// PASIYA API — Cloudflare Worker entry. Routes, account endpoints and static dashboard.
import { HttpError, json, CORS, stamp, sha256, randomHex, SITE, CREATOR } from './lib/util.js';
import * as fs from './lib/firestore.js';
import { serve, session, forgetKeys, isAdminEmail } from './lib/gateway.js';
import { CATALOG, LEGACY_SCRAPER } from './catalog.js';
import * as weather from './modules/weather.js';
import * as news from './modules/news.js';
import * as tv from './modules/tv.js';
import * as ai from './modules/ai.js';
import * as movies from './modules/movies.js';
import { forward } from './modules/scraper.js';
import * as bi from './modules/builtin.js';
import { status } from './modules/status.js';

const HANDLERS = {
  '/api/weather': weather.current, '/api/weather/sri-lanka': weather.sriLanka,
  '/api/news': news.latest, '/api/news/sources': news.sources,
  '/api/tv/channels': tv.channels,
  '/api/ai/gemini': ai.makeHandler('gemini'), '/api/ai/gpt': ai.makeHandler('gpt'), '/api/ai/deepseek': ai.makeHandler('deepseek'),
  '/api/ai/claude': ai.makeHandler('claude'), '/api/ai/llama': ai.makeHandler('llama'), '/api/ai/chat': ai.makeHandler(null),
  '/api/movie/search': movies.search, '/api/movie/details': movies.details, '/api/movie/trending': movies.trending
};
const DEFS = new Map(CATALOG.map((c) => [c.path, c]));
DEFS.set('/api/ai/chat', { path: '/api/ai/chat', cost: 1 });
// Built-in scrapers (inside the Worker) answer these; if the optional Node scraper is configured it takes over.
const BUILTIN = { '/api/scraper/youtube/search': bi.youtubeSearch, '/api/scraper/youtube/details': bi.youtubeDetails, '/api/scraper/tiktok/details': bi.tiktokDetails,
  '/api/scraper/facebook/details': bi.facebookDetails, '/api/scraper/instagram/details': bi.instagramDetails, '/api/scraper/mediafire/resolve': bi.mediafireResolve };
for (const c of CATALOG) if (c.path.startsWith('/api/scraper/')) {
  const fwd = forward('/v1/' + c.path.slice('/api/scraper/'.length)), own = BUILTIN[c.path];
  HANDLERS[c.path] = own ? (p, env, req) => (env.SCRAPER_URL && env.SCRAPER_SHARED_SECRET ? fwd(p, env, req) : own(p, env, req)) : fwd;
}
for (const l of LEGACY_SCRAPER) { const p = '/api/scraper/' + l; HANDLERS[p] = forward('/v1/' + l); if (!DEFS.has(p)) DEFS.set(p, { path: p, cost: 1 }); }

// ---- rewards: values are editable by the admin (Firestore settings/rewards) -------------------
// Spin wheel: [share of the max reward, weight]. The wheel in the browser only animates what the server decided.
const SPIN_SHAPE = [[0.04, 45], [0.1, 28], [0.2, 15], [0.4, 8], [1, 4]];
const posInt = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
async function rewardSettings(env) {
  let s = null;
  try { s = await fs.get(env, 'settings', 'rewards'); } catch { /* fall back to defaults */ }
  const daily = posInt(s?.dailyCoins, 1, 100000) ? s.dailyCoins : Number(env.DAILY_COINS || 5);
  const max = posInt(s?.spinMax, 5, 1000000) ? s.spinMax : 250;
  const rewards = SPIN_SHAPE.map(([f]) => Math.max(1, Math.round(max * f)));
  return { dailyCoins: daily, spinMax: max, spinRewards: rewards };
}
// "Today" follows Sri Lanka time (UTC+5:30) so claims reset at local midnight. Override with RESET_UTC_OFFSET_MIN.
const today = (env) => new Date(Date.now() + Number(env.RESET_UTC_OFFSET_MIN ?? 330) * 60000).toISOString().slice(0, 10);
const body = async (req) => { try { return await req.json(); } catch { throw new HttpError(400, 'Body must be valid JSON.'); } };

async function account(req, env, url, p, m) {
  if (p === '/api/me' && m === 'GET') {
    const c = await session(req, env);
    const r = await rewardSettings(env);
    return { ...c.p, emailVerified: c.u.verified ?? c.p.emailVerified, role: c.isAdmin ? 'admin' : 'user', unlimited: c.isAdmin, adminPending: !c.isAdmin && isAdminEmail(c.u.email, env, true), today: today(env), dailyCoins: r.dailyCoins, spinRewards: r.spinRewards };
  }
  if (p === '/api/keys' && m === 'GET') {
    const c = await session(req, env);
    return { keys: (await fs.query(env, 'apiKeys', 'uid', c.u.uid, 20)).filter((k) => !k.revoked).map((k) => ({ id: k.id, label: k.label, prefix: k.prefix, key: k.key || null, createdAt: k.createdAt })) };
  }
  if ((p === '/api/keys' || p === '/api/keys/ensure') && m === 'POST') {
    const c = await session(req, env);
    const active = (await fs.query(env, 'apiKeys', 'uid', c.u.uid, 20)).filter((k) => !k.revoked);
    if (p === '/api/keys/ensure' && active.length) return { created: false, prefix: active[0].prefix, key: active[0].key || null };
    if (active.length >= 5) throw new HttpError(400, 'You already have 5 active keys. Revoke one first.');
    const key = 'pasiya_' + randomHex(24);
    const id = await sha256(key);
    await fs.set(env, 'apiKeys', id, { uid: c.u.uid, hash: id, prefix: key.slice(0, 12), key, label: p === '/api/keys' ? 'API key' : 'Default key', revoked: false, createdAt: stamp() });
    return { created: true, id, key };
  }
  if (p === '/api/keys/revoke' && m === 'POST') {
    const c = await session(req, env);
    const b = await body(req);
    const k = await fs.get(env, 'apiKeys', String(b.id || ''));
    if (!k || k.uid !== c.u.uid) throw new HttpError(404, 'Key not found.');
    await fs.commit(env, [{ merge: ['apiKeys', b.id, { revoked: true, revokedAt: stamp() }] }]);
    forgetKeys();
    return { ok: true };
  }
  if (p === '/api/daily-claim' && m === 'POST') {
    const c = await session(req, env), day = today(env), r = await rewardSettings(env), n = r.dailyCoins;
    if (c.p.lastDailyClaim === day) throw new HttpError(409, 'Daily coins already claimed. Come back tomorrow.');
    // createId fails (409) if this user already claimed today, even for two simultaneous clicks.
    await fs.commit(env, [{ createId: ['claims', `${c.u.uid}_daily_${day}`, { uid: c.u.uid, day, type: 'daily', amount: n }] }, { merge: ['users', c.u.uid, { lastDailyClaim: day }] }, { inc: { doc: ['users', c.u.uid], by: { coins: n } } }])
      .catch((e) => { throw e.status === 409 ? new HttpError(409, 'Daily coins already claimed. Come back tomorrow.') : e; });
    await fs.add(env, 'coinHistory', { uid: c.u.uid, amount: n, balance: (c.p.coins || 0) + n, reason: 'Daily claim', createdAt: stamp() });
    return { message: `${n} coins added.`, amount: n };
  }
  if (p === '/api/spin' && m === 'POST') {
    const c = await session(req, env), day = today(env), r = await rewardSettings(env);
    if (c.p.lastSpinDay === day) throw new HttpError(409, 'You already spun today. Come back tomorrow.');
    const total = SPIN_SHAPE.reduce((a, x) => a + x[1], 0);
    let roll = (crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) * total, index = 0;
    for (; index < SPIN_SHAPE.length - 1; index++) { if (roll < SPIN_SHAPE[index][1]) break; roll -= SPIN_SHAPE[index][1]; }
    const reward = r.spinRewards[index];
    await fs.commit(env, [{ createId: ['claims', `${c.u.uid}_spin_${day}`, { uid: c.u.uid, day, type: 'spin', amount: reward }] }, { merge: ['users', c.u.uid, { lastSpinDay: day }] }, { inc: { doc: ['users', c.u.uid], by: { coins: reward } } }])
      .catch((e) => { throw e.status === 409 ? new HttpError(409, 'You already spun today. Come back tomorrow.') : e; });
    await fs.add(env, 'coinHistory', { uid: c.u.uid, amount: reward, balance: (c.p.coins || 0) + reward, reason: 'Lucky spin', createdAt: stamp() });
    return { reward, index, rewards: r.spinRewards, message: `You won ${reward} coins!` };
  }
  if (p === '/api/usage' && m === 'GET') {
    const c = await session(req, env);
    return { items: (await fs.query(env, 'usage', 'uid', c.u.uid, 100)).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 30) };
  }
  if (p === '/api/coins/history' && m === 'GET') {
    const c = await session(req, env);
    return { items: (await fs.query(env, 'coinHistory', 'uid', c.u.uid, 100)).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 30) };
  }
  if (p.startsWith('/api/admin/')) {
    const c = await session(req, env);
    if (!c.isAdmin) throw new HttpError(403, 'Admin access required.');
    if (p === '/api/admin/overview') return { users: await fs.count(env, 'users'), ...(await rewardSettings(env)) };
    if (p === '/api/admin/users' && m === 'GET') {
      const list = await fs.query(env, 'users', null, null, 100);
      return { items: list.map((u) => ({ uid: u.uid || u.id, email: u.email, coins: u.coins || 0, totalRequests: u.totalRequests || 0, createdAt: u.createdAt })).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')) };
    }
    if (p === '/api/admin/settings' && m === 'POST') {
      const b = await body(req);
      if (!posInt(b.dailyCoins, 1, 100000) || !posInt(b.spinMax, 5, 1000000)) throw new HttpError(400, 'Daily coins must be 1-100000 and the biggest spin prize 5-1000000 (whole numbers).');
      await fs.commit(env, [{ merge: ['settings', 'rewards', { dailyCoins: b.dailyCoins, spinMax: b.spinMax, updatedAt: stamp(), updatedBy: c.u.email }] }]);
      return { message: 'Reward settings saved.', ...(await rewardSettings(env)) };
    }
    if (p === '/api/admin/coins' && m === 'POST') {
      const b = await body(req);
      if ((!b.uid && !b.email) || !Number.isInteger(b.amount) || b.amount === 0 || Math.abs(b.amount) > 1_000_000) throw new HttpError(400, 'Provide a user email and a whole, non-zero coin amount.');
      const target = b.uid ? await fs.get(env, 'users', b.uid) : (await fs.query(env, 'users', 'email', String(b.email).trim().toLowerCase(), 1))[0];
      if (!target) throw new HttpError(404, 'No user with that email. They must register on the website first.');
      const uid = target.uid || target.id, have = target.coins || 0;
      const amount = Math.max(b.amount, -have); // removing never takes a balance below 0
      await fs.commit(env, [{ inc: { doc: ['users', uid], by: { coins: amount } } }]);
      await fs.add(env, 'coinHistory', { uid, amount, balance: have + amount, reason: amount > 0 ? 'Admin gift' : 'Admin adjustment', actor: c.u.uid, createdAt: stamp() });
      return { message: `${amount > 0 ? 'Added' : 'Removed'} ${Math.abs(amount)} coins ${amount > 0 ? 'to' : 'from'} ${target.email}. New balance: ${have + amount}.` };
    }
  }
  return undefined;
}

async function route(req, env, ctx) {
  const url = new URL(req.url), p = url.pathname.replace(/\/+$/, '') || '/', m = req.method;
  if (m === 'OPTIONS') return new Response(null, { headers: CORS });
  if (!p.startsWith('/api/')) return env.ASSETS.fetch(req);

  if (p === '/api/health' || p === '/api/ping') return json({ ok: true, service: SITE, creator: CREATOR, time: stamp() });
  if (p === '/api/status') return json({ success: true, ...(await status(req, env)) }, 200, { 'Cache-Control': 'no-store' });
  if (p === '/api/catalog') {
    const list = CATALOG.map(({ needs, ...c }) => ({ ...c, method: 'GET' }));
    return json({ success: true, apis: list }, 200, { 'Cache-Control': 'public, max-age=300' });
  }
  if (HANDLERS[p] && (m === 'GET' || m === 'POST')) return serve(req, env, ctx, DEFS.get(p), HANDLERS[p]);
  if (HANDLERS[p]) throw new HttpError(405, 'Use GET or POST.');

  const r = await account(req, env, url, p, m);
  if (r !== undefined) return json(r);
  throw new HttpError(404, 'Endpoint not found. See /api/catalog.');
}

export default {
  async fetch(req, env, ctx) {
    try { return await route(req, env, ctx); }
    catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (!(e instanceof HttpError)) console.error(e?.stack || e);
      return json({ success: false, error: e instanceof HttpError ? e.message : 'Unexpected error.' }, status);
    }
  }
};
