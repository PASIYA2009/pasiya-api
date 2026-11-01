// CineSubz movie search / details / download (free dtz-movie-script API, no API key needed).
import { existsSync, mkdirSync, rmSync, readdirSync, createWriteStream } from 'fs';
import { open } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { assertPublicUrl } from '../lib/net-guard.js';

const API = String(process.env.CINESUBZ_API_URL || 'https://dtz-movie-script.vercel.app/api/movie').replace(/\/+$/, '');   // CINESUBZ_API_URL lets you switch to another host without code changes
const TMP_DIR = './tmp/cinesubz';          // not touched by the janitor (big files take long to upload)
// WhatsApp's hard limit for a document is 2 GB.
export const MAX_MB = Number(process.env.CINESUBZ_MAX_MB || 2000);

if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
try { for (const f of readdirSync(TMP_DIR)) rmSync(join(TMP_DIR, f), { force: true }); } catch {}   // leftovers from a crash

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TIMEOUT = { cinesubzsearch: 45000, cinesubzdetails: 90000, cinesubzdown: 120000 };   // details / dl scrape the site, they can be slow

// Calls the API. Retries once on timeouts, network errors, 5xx and blocked (403/429) answers, with different headers.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HEADER_SETS = [
  { accept: 'application/json' },
  { accept: 'application/json, text/plain, */*', 'user-agent': BROWSER_UA, 'accept-language': 'en-US,en;q=0.9' },
  { accept: 'application/json, text/plain, */*', 'user-agent': BROWSER_UA, 'accept-language': 'en-US,en;q=0.9', referer: 'https://dtz-movie-script.vercel.app/' },
  { accept: '*/*', 'user-agent': 'curl/8.5.0' }
];
async function api(path, params) {
  const qs = new URLSearchParams(params);
  let lastErr;
  // 503 / 429 / 403 / timeouts are often temporary (API busy or a bot filter): retry with a pause and different headers.
  for (let attempt = 0; attempt < HEADER_SETS.length; attempt++) {
    if (attempt) await sleep(2000 * attempt);
    let res, text;
    try {
      res = await fetch(`${API}/${path}?${qs}`, { headers: HEADER_SETS[attempt], signal: AbortSignal.timeout(TIMEOUT[path] || 60000) });
      text = await res.text();
    } catch (e) {
      lastErr = new Error(e?.name === 'TimeoutError' || e?.name === 'AbortError'
        ? 'CineSubz API took too long to answer. Try again in a moment.'
        : `Could not reach the CineSubz API (${e?.cause?.code || e?.message || 'network error'}).`);
      console.error(`CineSubz API /${path} attempt ${attempt + 1}: ${lastErr.message}`);
      continue;
    }
    let json;
    try { json = JSON.parse(text); } catch {
      const snippet = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
      console.error(`CineSubz API /${path} attempt ${attempt + 1}: HTTP ${res.status} (not JSON) server:${res.headers.get('server') || '?'} body:${snippet}`);
      lastErr = new Error(`CineSubz API returned an invalid response (HTTP ${res.status})${snippet ? `: ${snippet}` : ''}`);
      continue;
    }
    const failed = !res.ok || json?.success === false || json?.status === false || json?.status === 'error' || json?.error;   // this API answers { creator, status: true, result }
    if (failed) {
      lastErr = new Error(`${json?.message || (typeof json?.error === 'string' ? json.error : '') || 'CineSubz API error'} (HTTP ${res.status})`);
      console.error(`CineSubz API /${path} attempt ${attempt + 1}: ${lastErr.message}`);
      if (res.status >= 500 || res.status === 403 || res.status === 429) continue;
      throw lastErr;
    }
    const result = json?.result ?? json?.results ?? json?.data;
    if (result === undefined || result === null) throw new Error('CineSubz API returned no data.');
    return result;
  }
  throw lastErr;
}

export const cleanTitle = (t) => String(t || '').split('|')[0].replace(/\s*Sinhala Subtitles\s*/i, ' ').replace(/\s+/g, ' ').trim();

export async function cineSearch(q) {
  const r = await api('cinesubzsearch', { q, page: 1, limit: 10 });
  const list = Array.isArray(r) ? r : (Array.isArray(r?.movies) ? r.movies : (Array.isArray(r?.results) ? r.results : []));
  return list
    .map((x) => ({ ...x, link: x?.url || x?.link || x?.href || '', image: x?.poster || x?.poster_thumb || x?.image || x?.thumbnail || '' }))
    .filter((x) => x.link);
}
export async function cineDetails(url) {
  const d = await api('cinesubzdetails', { url });
  if (!d || typeof d !== 'object') throw new Error('CineSubz API returned no details for this title.');
  const raw = d.downloads || d.download_links || d.downloadLinks || d.links || [];
  // entries look like { label, quality: '480p', size: '700 MB', language: 'English', portal_url } -> the shape the bot menus expect ({ href, meta })
  const downloads = (Array.isArray(raw) ? raw : []).map((x) => ({
    ...x,
    href: x?.href || x?.portal_url || x?.url || x?.link || '',
    meta: x?.meta || [`${d.quality || ''} ${x?.quality || ''}`.trim(), x?.size, x?.language].filter(Boolean).join(' • ') || x?.label || ''
  }));
  return { ...d, downloads };
}

// Walks any JSON and collects every http(s) URL together with the key it was found under.
function collectUrls(node, out = [], key = '') {
  if (typeof node === 'string') { if (/^https?:\/\//i.test(node.trim())) out.push({ url: node.trim(), key }); }
  else if (Array.isArray(node)) node.forEach((n) => collectUrls(n, out, key));
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) collectUrls(v, out, k);
  return out;
}
const IMG_RE = /\.(jpe?g|png|gif|webp|svg)(\?|$)/i;
function fixHost(u) {   // page links of file hosts -> direct file links
  const m = u.match(/^https?:\/\/(?:www\.)?pixeldrain\.(?:com|dev)\/u\/([\w-]+)/i);
  return m ? `https://pixeldrain.com/api/file/${m[1]}?download` : u;
}

// Always returns { mirrors: [{ type, url }] }  (the "down" endpoint's exact shape is not fixed, so every link in the answer is considered)
export async function cineLinks(zt) {
  const d = await api('cinesubzdown', { url: zt });
  const seen = new Set();
  const mirrors = collectUrls(d)
    .filter((x) => !IMG_RE.test(x.url) && !/t\.me\/|telegram\.(me|org)/i.test(x.url) && x.url !== zt)
    .map((x) => ({ type: /direct|download|dl|file|video|mp4|stream/i.test(x.key) || /\.(mp4|mkv|avi|webm)(\?|$)/i.test(x.url) ? 'direct_file' : 'link', url: fixHost(x.url), key: x.key }))
    .sort((a, b) => (/direct/i.test(b.key) - /direct/i.test(a.key)) || ((b.type === 'direct_file') - (a.type === 'direct_file')))
    .filter((x) => !seen.has(x.url) && seen.add(x.url));
  return { ...(d && !Array.isArray(d) && typeof d === 'object' ? d : {}), mirrors };
}

// "BluRay 480p • 1.6 GB • English"  ->  { quality: '480p', size: '1.6 GB', sizeMB: 1638, source: 'BluRay', lang: 'English' }
export function parseMeta(meta) {
  const text = String(meta || '');
  const q = text.match(/(\d{3,4})p/i)?.[1];
  const s = text.match(/([\d.]+)\s*(GB|MB)/i);
  const sizeMB = s ? Math.round(parseFloat(s[1]) * (/gb/i.test(s[2]) ? 1024 : 1)) : 0;
  const parts = text.split('•').map(x => x.trim());
  return {
    quality: q ? `${q}p` : (parts[0] || 'File'),
    size: s ? `${s[1]} ${s[2].toUpperCase()}` : '',
    sizeMB,
    source: parts[0]?.replace(/\d{3,4}p/i, '').trim() || '',
    lang: parts[2] || ''
  };
}

// Turns the details response into a list of download links, sorted 480p -> 720p -> 1080p
export function linksFromDownloads(list) {
  return (Array.isArray(list) ? list : [])
    .filter(d => d?.href)
    .map(d => ({ href: d.href, ...parseMeta(d.meta) }))
    .sort((a, b) => parseInt(a.quality) - parseInt(b.quality));
}

const CONNECTIONS = Math.max(1, Number(process.env.DL_CONNECTIONS || 8));   // parallel connections per file
const CHUNK = 8 * 1048576;

async function fetchRange(url, start, end, { referer, UA }) {
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), 30000);
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': UA, referer, accept: '*/*', range: `bytes=${start}-${end}` }, signal: ctrl.signal });
  clearTimeout(timer);
  if (res.status !== 206) { try { await res.body?.cancel(); } catch {} throw new Error(`Range not supported (HTTP ${res.status})`); }
  const bump = () => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), 30000); };   // abort a stalled piece
  return { res, bump, stop: () => clearTimeout(timer) };
}

async function parallelDownload(url, file, size, opts) {
  const fh = await open(file, 'w');
  try {
    await fh.truncate(size);
    const pieces = [];
    for (let s = 0; s < size; s += CHUNK) pieces.push([s, Math.min(s + CHUNK, size) - 1]);
    let next = 0, done = 0;
    const worker = async () => {
      while (next < pieces.length) {
        const [start, end] = pieces[next++];
        let ok = false, lastErr;
        for (let attempt = 0; attempt < 4 && !ok; attempt++) {
          let pos = start;
          try {
            const { res, bump, stop } = await fetchRange(url, start, end, opts);
            try {
              for await (const chunk of Readable.fromWeb(res.body)) {
                bump();
                if (pos + chunk.length - 1 > end) throw new Error('Server sent too much data');
                await fh.write(chunk, 0, chunk.length, pos);
                pos += chunk.length; done += chunk.length;
                if (opts.onProgress) { try { opts.onProgress(done, size); } catch {} }
              }
            } finally { stop(); }
            if (pos !== end + 1) throw new Error('Piece ended early');
            ok = true;
          } catch (e) { lastErr = e; done -= (pos - start); await sleep(500 * (attempt + 1)); }
        }
        if (!ok) throw lastErr || new Error('Piece failed');
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONNECTIONS, pieces.length) }, worker));
  } finally { await fh.close(); }
}

// Streams a (possibly multi-GB) file to disk. Never holds it in RAM, refuses private addresses, no total timeout.
export async function downloadToFile(url, { maxMB = MAX_MB, referer = 'https://cinesubz.net/', onProgress } = {}) {
  const maxBytes = maxMB * 1024 * 1024;
  let current = String(url);
  let res;
  for (let hop = 0; hop < 6; hop++) {
    await assertPublicUrl(current);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 60000);          // only for the response headers
    try {
      res = await fetch(current, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36', referer, accept: '*/*' }, signal: ctrl.signal });
    } finally { clearTimeout(t); }
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current).toString();
      try { await res.body?.cancel(); } catch {}
      res = null;
      continue;
    }
    break;
  }
  if (!res) throw new Error('Too many redirects.');
  if (!res.ok) throw new Error(`Download server answered HTTP ${res.status}.`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len && len > maxBytes) { try { await res.body?.cancel(); } catch {} const e = new Error('TOO_BIG'); e.sizeMB = Math.round(len / 1048576); throw e; }
  if (!res.body) throw new Error('Unable to read the download stream.');
  const ctype = String(res.headers.get('content-type') || '').toLowerCase();
  if (/text\/html|application\/json/.test(ctype)) { try { await res.body.cancel(); } catch {} throw new Error('The download link has expired or is not a video file. Please try again.'); }

  const file = join(TMP_DIR, `${randomUUID()}.mp4`);
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';

  // FAST PATH: server supports Range -> download many pieces at the same time (several times faster than one connection).
  const ranges = /bytes/i.test(res.headers.get('accept-ranges') || '');
  if (ranges && len > 16 * 1048576 && CONNECTIONS > 1) {
    try { await res.body.cancel(); } catch {}
    try {
      await parallelDownload(current, file, len, { referer, UA, onProgress });
      return { file, size: len, finalUrl: current };
    } catch (e) {
      cleanupCine(file);
      if (e?.message === 'TOO_BIG') throw e;
      console.error('Parallel download failed, falling back to single connection:', e?.message || e);
      // re-open a normal single stream
      await assertPublicUrl(current);
      res = await fetch(current, { redirect: 'follow', headers: { 'user-agent': UA, referer, accept: '*/*' } });
      if (!res.ok || !res.body) throw new Error(`Download server answered HTTP ${res.status}.`);
    }
  }

  let total = 0;
  const cap = new Transform({
    transform(chunk, _e, cb) {
      total += chunk.length;
      if (onProgress) { try { onProgress(total, len); } catch {} }
      if (total > maxBytes) return cb(Object.assign(new Error('TOO_BIG'), { sizeMB: Math.round(total / 1048576) }));
      cb(null, chunk);
    }
  });
  try {
    await pipeline(Readable.fromWeb(res.body), cap, createWriteStream(file));
    return { file, size: total, finalUrl: current };
  } catch (e) { cleanupCine(file); throw e; }
}

export function cleanupCine(file) { try { if (file && existsSync(file)) rmSync(file, { force: true }); } catch {} }

export function fileNameFromUrl(url, fallback) {
  try {
    const n = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    if (n) return n.replace(/[\\/:*?"<>|\x00-\x1F]/g, '_');
  } catch {}
  return `${fallback}.mp4`.replace(/[\\/:*?"<>|\x00-\x1F]/g, '_');
}

// All usable direct-file links of a dl response, best first (direct_file type, then any other http mirror that looks like a file).
export function directUrls(dl) {
  const m = Array.isArray(dl?.mirrors) ? dl.mirrors : [];
  const direct = m.filter((x) => x.type === 'direct_file').map((x) => x.url);
  const filey = m.filter((x) => x.type !== 'direct_file' && /\.(mp4|mkv|avi|webm)(\?|$)/i.test(x.url)).map((x) => x.url);
  const best = [...new Set([...direct, ...filey])];
  return best.length ? best : [...new Set(m.map((x) => x.url))];   // unknown shape: still try every link, the downloader rejects HTML pages
}
