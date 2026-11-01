// Small shared helpers. Everything here is dependency-free and cheap on CPU.
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const CREATOR = 'Pasidu Eshan';
export const SITE = 'PASIYA API';

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-API-Key',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Max-Age': '86400'
};

export const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS, ...extra }
  });

export const stamp = () => new Date().toISOString();
const enc = new TextEncoder();
export const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
export const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
export const randomHex = (bytes = 24) => hex(crypto.getRandomValues(new Uint8Array(bytes)));
export const clamp = (n, lo, hi, d) => { n = Number(n); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : d; };

// ---- text helpers -----------------------------------------------------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export function decodeEntities(s) {
  return String(s || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}
export const stripHtml = (s) => decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

// ---- fetch with timeout ----------------------------------------------
export async function fetchT(url, opts = {}, ms = 12000) {
  try {
    return await fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new HttpError(504, 'Upstream service took too long to answer.');
    throw new HttpError(502, 'Could not reach the upstream service.');
  }
}

// ---- cache with "stale if error": when a 3rd-party site is down, the last good answer is served ------
// Fresh copy: isolate memory (<=60s) + Cloudflare Cache API (ttlSec). Stale copy: kept for 7 days.
const mem = new Map();
const MEM_MAX = 150;
const STALE_SEC = 7 * 86400;
const cacheReq = (key, tag) => new Request(`https://cache.pasiya.internal/${tag}/` + encodeURIComponent(key));
export async function cached(key, ttlSec, fn) {
  const now = Date.now();
  const m = mem.get(key);
  if (m && m.exp > now) return m.v;
  const store = globalThis.caches?.default;
  if (store) {
    try {
      const hit = await store.match(cacheReq(key, 'f'));
      if (hit) { const v = await hit.json(); mem.set(key, { v, exp: now + Math.min(ttlSec, 60) * 1000 }); return v; }
    } catch { /* cache is best effort */ }
  }
  let v;
  try { v = await fn(); }
  catch (e) {
    // Only upstream/network failures fall back to old data; "not found" / bad input errors must still reach the caller.
    if (e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 429) throw e;
    const old = mem.get(key)?.stale;
    if (old !== undefined) return old;
    if (store) { try { const hit = await store.match(cacheReq(key, 's')); if (hit) return await hit.json(); } catch { /* ignore */ } }
    throw e;
  }
  if (mem.size >= MEM_MAX) mem.delete(mem.keys().next().value);
  mem.set(key, { v, stale: v, exp: now + Math.min(ttlSec, 60) * 1000 });
  if (store) {
    const put = (tag, age) => store.put(cacheReq(key, tag), new Response(JSON.stringify(v), { headers: { 'Cache-Control': `public, max-age=${age}` } })).catch(() => {});
    await Promise.all([put('f', ttlSec), put('s', STALE_SEC)]);
  }
  return v;
}
