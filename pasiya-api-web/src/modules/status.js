// Public live status for the dashboard cards.
import { cached } from '../lib/util.js';
import { statsLast24h } from '../lib/gateway.js';
import { CATALOG } from '../catalog.js';

export async function status(req, env) {
  const cf = req.cf || {};
  let db = { ok: false, name: 'Firebase Firestore', note: 'Not configured' };
  let stats = { requests: 0, errors: 0, avgMs: 0, successRate: 100 };
  if (env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      stats = await cached('status:24h', 30, () => statsLast24h(env));
      db = { ok: true, name: 'Firebase Firestore', note: 'Connected' };
    } catch (e) { db = { ok: false, name: 'Firebase Firestore', note: 'Unreachable' }; }
  }
  const listed = CATALOG;
  const started = env.PLATFORM_START ? new Date(env.PLATFORM_START).getTime() : null;
  return {
    status: db.ok || !env.FIREBASE_SERVICE_ACCOUNT_JSON ? 'Online' : 'Degraded',
    ip: req.headers.get('CF-Connecting-IP') || null,
    location: [cf.city, cf.country].filter(Boolean).join(', ') || null,
    edge: { colo: cf.colo || (req.headers.get('cf-ray') || '').split('-')[1] || null, protocol: cf.httpProtocol || null, network: 'Cloudflare' },
    database: db,
    uptimeMs: started && !isNaN(started) ? Date.now() - started : null,
    endpoints: listed.length,
    categories: new Set(listed.map((c) => c.category)).size,
    requests24h: stats.requests, errors24h: stats.errors, avgResponseMs: stats.avgMs, successRate: stats.successRate,
    time: new Date().toISOString()
  };
}
