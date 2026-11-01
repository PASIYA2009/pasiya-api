import express from 'express';
import crypto from 'node:crypto';
import youtubeDlExec from 'youtube-dl-exec';
import { scrapeMediaFire, isMediaFireUrl } from './providers/mediafire.js';
import { cineSearch, cineDetails, cineLinks } from './providers/cinesubz.js';
import { ssSearch, ssDetails, ssDirect } from './providers/sinhalasub.js';
import { assertPublicUrl } from './lib/net-guard.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));
const API_KEY = String(process.env.API_KEY || '').trim();
const PORT = Number(process.env.PORT || 3000);
const MAX_JOBS = Math.max(1, Math.min(8, Number(process.env.MAX_CONCURRENT_JOBS || 1)));
let activeJobs = 0;

if (!API_KEY || API_KEY.length < 24) {
  console.error('FATAL: Set API_KEY to a random secret of at least 24 characters.');
  process.exit(1);
}

function auth(req, res, next) {
  const supplied = String(req.get('x-api-key') || '');
  const a = Buffer.from(supplied);
  const b = Buffer.from(API_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}
function jobLimit(req, res, next) {
  if (activeJobs >= MAX_JOBS) return res.status(429).json({ success: false, error: 'Server is busy. Try again shortly.' });
  activeJobs++;
  let released = false;
  const release = () => { if (!released) { released = true; activeJobs = Math.max(0, activeJobs - 1); } };
  res.on('finish', release);
  res.on('close', release);
  next();
}
function text(value, name, max = 300) {
  const s = String(value ?? '').trim();
  if (!s || s.length > max) throw Object.assign(new Error(`${name} is required (max ${max} characters).`), { status: 400 });
  return s;
}
async function safeUrl(value, allowedHosts = []) {
  const u = await assertPublicUrl(value);
  if (allowedHosts.length && !allowedHosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) {
    throw Object.assign(new Error('URL host is not supported for this endpoint.'), { status: 400 });
  }
  return u.toString();
}
function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
const ytCache = new Map();
async function yt(source, options = {}) {
  const ck = source + JSON.stringify(options);
  const hit = ytCache.get(ck);
  if (hit && hit.exp > Date.now()) return hit.v;
  const v = await ytRun(source, options);
  if (ytCache.size >= 100) ytCache.delete(ytCache.keys().next().value);
  ytCache.set(ck, { v, exp: Date.now() + 10 * 60 * 1000 });
  return v;
}
async function ytRun(source, options = {}) {
  return youtubeDlExec(source, {
    dumpSingleJson: true, skipDownload: true, noWarnings: true,
    noPlaylist: true, socketTimeout: 30,
    jsRuntimes: 'node', extractorArgs: 'youtube:player_client=android,web',
    ...options
  }, { timeout: Number(process.env.REQUEST_TIMEOUT_MS || 120000), killSignal: 'SIGKILL' });
}

app.get('/health', (_req, res) => res.json({ success: true, service: 'PASIYA Scraper API', version: '1.3.0' }));
app.use('/v1', auth, jobLimit);

// Platform search and details return metadata only. They do not bypass account,
// privacy, DRM, or platform download controls.
const PLATFORM_HOSTS = {
  youtube: ['youtube.com', 'youtu.be'],
  facebook: ['facebook.com', 'fb.watch'],
  tiktok: ['tiktok.com'],
  instagram: ['instagram.com']
};
const platformSearchUrl = (platform, query) => ({
  youtube: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
  facebook: `https://www.facebook.com/search/top?q=${encodeURIComponent(query)}`,
  tiktok: `https://www.tiktok.com/search?q=${encodeURIComponent(query)}`,
  instagram: `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(query)}`
}[platform]);
function cleanMetadata(d, url) {
  return {
    id: d.id || null,
    title: d.title || d.description?.slice(0, 100) || 'Untitled media',
    description: d.description || null,
    uploader: d.uploader || d.channel || d.creator || null,
    duration: Number(d.duration || 0),
    views: Number(d.view_count || 0),
    likes: Number(d.like_count || 0),
    webpageUrl: d.webpage_url || url,
    thumbnail: d.thumbnail || null,
    platform: d.extractor_key || d.extractor || null
  };
}
app.post('/v1/youtube/search', asyncRoute(async (req, res) => {
  const query = text(req.body?.query, 'query', 200);
  const limit = Math.max(1, Math.min(10, Number(req.body?.limit) || 5));
  const data = await yt(`ytsearch${limit}:${query}`, { flatPlaylist: true });
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  res.json({ success: true, platform: 'youtube', query, results: entries.map((v, i) => ({ number: i + 1, id: v.id || null, title: v.title || 'Unknown title', url: v.webpage_url || v.url || (v.id ? `https://www.youtube.com/watch?v=${v.id}` : null), duration: v.duration || 0, uploader: v.uploader || v.channel || null, thumbnail: v.thumbnail || null })) });
}));
app.post('/v1/youtube/details', asyncRoute(async (req, res) => {
  const url = await safeUrl(text(req.body?.url, 'url'), PLATFORM_HOSTS.youtube);
  const d = await yt(url, { skipDownload: true });
  res.json({ success: true, platform: 'youtube', info: cleanMetadata(d, url) });
}));
app.post('/v1/youtube/download', asyncRoute(async (req, res) => authorizedMedia(req, res, 'youtube')));

for (const platform of ['facebook', 'tiktok', 'instagram']) {
  app.post(`/v1/${platform}/search`, asyncRoute(async (req, res) => {
    const query = text(req.body?.query, 'query', 200);
    // Platform-wide search APIs require approved developer credentials and scopes.
    res.status(501).json({ success: false, platform, error: 'Platform search is not available through an unrestricted public scraper.', searchUrl: platformSearchUrl(platform, query), note: 'Use the official platform search or connect an approved developer API.' });
  }));
  app.post(`/v1/${platform}/details`, asyncRoute(async (req, res) => {
    const url = await safeUrl(text(req.body?.url, 'url'), PLATFORM_HOSTS[platform]);
    const d = await yt(url, { skipDownload: true });
    res.json({ success: true, platform, info: cleanMetadata(d, url) });
  }));
  app.post(`/v1/${platform}/download`, asyncRoute(async (req, res) => authorizedMedia(req, res, platform)));
}

async function authorizedMedia(req, res, platform) {
  if (req.body?.rightsConfirmed !== true) {
    return res.status(400).json({ success: false, error: 'Set rightsConfirmed=true only when you own the media or have explicit permission to download it.' });
  }
  const hosts = String(process.env.AUTHORIZED_MEDIA_HOSTS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  if (!hosts.length) return res.status(503).json({ success: false, error: 'Authorized direct downloads are disabled. Configure AUTHORIZED_MEDIA_HOSTS with domains hosting media you own or are permitted to download.' });
  const url = await safeUrl(text(req.body?.url, 'url'), hosts);
  res.json({ success: true, platform, download: { url, mode: 'authorized_direct_link', note: 'This endpoint only returns direct links hosted on your configured authorized domains. It does not extract media from social-platform pages.' } });
}
app.post('/v1/mediafire/resolve', asyncRoute(async (req, res) => {
  const url = await safeUrl(text(req.body?.url, 'url'), ['mediafire.com']);
  if (!isMediaFireUrl(url)) throw Object.assign(new Error('Invalid MediaFire URL.'), { status: 400 });
  res.json({ success: true, result: await scrapeMediaFire(url) });
}));
app.post('/v1/cinesubz/search', asyncRoute(async (req, res) => res.json({ success: true, results: await cineSearch(text(req.body?.query, 'query', 160)) })));
app.post('/v1/cinesubz/details', asyncRoute(async (req, res) => {
  const url = await safeUrl(text(req.body?.url, 'url'));
  res.json({ success: true, result: await cineDetails(url) });
}));
app.post('/v1/cinesubz/links', asyncRoute(async (req, res) => {
  const url = await safeUrl(text(req.body?.url, 'url'));
  res.json({ success: true, result: await cineLinks(url) });
}));
app.post('/v1/sinhalasub/search', asyncRoute(async (req, res) => res.json({ success: true, results: await ssSearch(text(req.body?.query, 'query', 160)) })));
app.post('/v1/sinhalasub/details', asyncRoute(async (req, res) => {
  const url = await safeUrl(text(req.body?.url, 'url'));
  res.json({ success: true, result: await ssDetails(url) });
}));
app.post('/v1/sinhalasub/direct', asyncRoute(async (req, res) => {
  const url = await safeUrl(text(req.body?.url, 'url'));
  res.json({ success: true, result: await ssDirect(url) });
}));

app.use((err, _req, res, _next) => {
  const status = Number(err?.status) || (err?.name === 'TimeoutError' ? 504 : err?.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  console.error('[API]', err?.stack || err);
  res.status(status).json({ success: false, error: status >= 500 && status !== 503 && status !== 504 ? 'Scraper request failed. Check server logs or try again.' : (err.message || 'Request failed.') });
});
app.listen(PORT, '0.0.0.0', () => console.log(`PASIYA Scraper API listening on ${PORT}; max jobs=${MAX_JOBS}`));
