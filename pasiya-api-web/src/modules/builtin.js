// Built-in scrapers that run INSIDE the Worker, so YouTube / TikTok / Facebook / Instagram / MediaFire metadata
// and keyless movie lookups work without any separate server or API key. Public pages only, metadata only.
// If SCRAPER_URL is configured, the optional Node scraper is used instead (see src/index.js).
import { HttpError, fetchT, cached, clamp, decodeEntities, stripHtml } from '../lib/util.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HOSTS = {
  youtube: ['youtube.com', 'youtu.be'], facebook: ['facebook.com', 'fb.watch'], tiktok: ['tiktok.com'],
  instagram: ['instagram.com'], mediafire: ['mediafire.com']
};
// Only https links on the platform's own domain are ever fetched (no user-controlled hosts).
function safeUrl(raw, platform) {
  let u; try { u = new URL(String(raw || '').trim()); } catch { throw new HttpError(400, 'url must be a full link (https://...).'); }
  const ok = u.protocol === 'https:' && !u.username && HOSTS[platform].some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
  if (!ok) throw new HttpError(400, `This endpoint only accepts ${HOSTS[platform].join(' / ')} links.`);
  return u.toString();
}
const page = async (url, headers = {}) => {
  const r = await fetchT(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1; SOCS=CAI', ...headers }, redirect: 'follow' }, 15000);
  if (!r.ok) throw new HttpError(r.status === 404 ? 404 : 502, r.status === 404 ? 'Not found (private or removed).' : `Source site answered HTTP ${r.status}.`);
  return r.text();
};
const meta = (html, prop) => {
  const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i'))
    || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i'));
  return m ? decodeEntities(m[1]).trim() : null;
};
function jsonAfter(html, marker) { // JSON object that follows `marker =` in an inline script
  const i = html.indexOf(marker); if (i < 0) return null;
  const s = html.indexOf('{', i); let depth = 0, str = false, esc = false;
  for (let k = s; k < html.length; k++) {
    const c = html[k];
    if (str) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') str = false; continue; }
    if (c === '"') str = true; else if (c === '{') depth++; else if (c === '}' && --depth === 0) { try { return JSON.parse(html.slice(s, k + 1)); } catch { return null; } }
  }
  return null;
}
function walk(o, key, out = [], max = 25) {
  if (!o || typeof o !== 'object' || out.length >= max) return out;
  if (Array.isArray(o)) { for (const x of o) walk(x, key, out, max); return out; }
  if (o[key]) out.push(o[key]);
  for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v, key, out, max);
  return out;
}
const num = (t) => Number(String(t || '').replace(/[^\d]/g, '')) || 0;
const secs = (t) => String(t || '').split(':').reverse().reduce((a, x, i) => a + Number(x) * 60 ** i, 0) || 0;

// ---------- YouTube ----------
export async function youtubeSearch(p) {
  const query = String(p.query || p.q || '').trim();
  if (!query || query.length > 200) throw new HttpError(400, 'query is required (max 200 characters).');
  const limit = clamp(p.limit, 1, 10, 5);
  const data = await cached('yts:' + query.toLowerCase(), 900, async () => {
    const html = await page('https://www.youtube.com/results?hl=en&search_query=' + encodeURIComponent(query));
    const yi = jsonAfter(html, 'ytInitialData');
    const vids = walk(yi, 'videoRenderer', [], 20);
    if (!vids.length) throw new HttpError(502, 'YouTube did not return results right now. Try again shortly.');
    return vids.map((v) => ({
      id: v.videoId, title: v.title?.runs?.map((r) => r.text).join('') || 'Unknown title', url: 'https://www.youtube.com/watch?v=' + v.videoId,
      duration: secs(v.lengthText?.simpleText), uploader: v.ownerText?.runs?.[0]?.text || null, views: num(v.viewCountText?.simpleText),
      published: v.publishedTimeText?.simpleText || null, thumbnail: v.thumbnail?.thumbnails?.at(-1)?.url || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`
    }));
  });
  return { platform: 'youtube', query, results: data.slice(0, limit).map((v, i) => ({ number: i + 1, ...v })) };
}
export async function youtubeDetails(p) {
  const url = safeUrl(p.url, 'youtube');
  const info = await cached('ytd:' + url, 3600, async () => {
    const r = await fetchT('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(url), { headers: { 'User-Agent': UA } }, 12000);
    if (r.status === 404 || r.status === 400 || r.status === 401) throw new HttpError(404, 'Video not found or not public.');
    if (!r.ok) throw new HttpError(502, 'YouTube is not answering right now.');
    const o = await r.json();
    const out = { id: null, title: o.title, description: null, uploader: o.author_name, uploaderUrl: o.author_url, duration: 0, views: 0, likes: 0, webpageUrl: url, thumbnail: o.thumbnail_url, platform: 'Youtube' };
    try { // best-effort extras from the watch page
      const pr = jsonAfter(await page(url), 'ytInitialPlayerResponse')?.videoDetails;
      if (pr) Object.assign(out, { id: pr.videoId, description: pr.shortDescription || null, duration: Number(pr.lengthSeconds) || 0, views: Number(pr.viewCount) || 0 });
    } catch { /* oEmbed data is enough */ }
    return out;
  });
  return { platform: 'youtube', info };
}

// ---------- TikTok / Facebook / Instagram (public link metadata) ----------
export async function tiktokDetails(p) {
  const url = safeUrl(p.url, 'tiktok');
  const info = await cached('tt:' + url, 3600, async () => {
    const r = await fetchT('https://www.tiktok.com/oembed?url=' + encodeURIComponent(url), { headers: { 'User-Agent': UA } }, 12000);
    if (!r.ok) throw new HttpError(r.status === 400 ? 404 : 502, r.status === 400 ? 'Video not found or not public.' : 'TikTok is not answering right now.');
    const o = await r.json();
    return { id: o.embed_product_id || null, title: o.title || 'Untitled media', description: o.title || null, uploader: o.author_name, uploaderUrl: o.author_url, duration: 0, views: 0, likes: 0, webpageUrl: url, thumbnail: o.thumbnail_url, platform: 'TikTok' };
  });
  return { platform: 'tiktok', info };
}
const ogDetails = (platform, label) => async (p) => {
  const url = safeUrl(p.url, platform);
  const info = await cached(platform + ':' + url, 3600, async () => {
    // Social sites show their public preview tags to link-preview bots.
    const html = await page(url, { 'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' });
    const title = meta(html, 'og:title'), image = meta(html, 'og:image');
    if (!title && !image) throw new HttpError(404, 'No public preview found (private post, login required or removed).');
    return { id: null, title: title || 'Untitled media', description: meta(html, 'og:description'), uploader: meta(html, 'og:site_name') === label ? null : meta(html, 'og:site_name'), duration: 0, views: 0, likes: 0, webpageUrl: meta(html, 'og:url') || url, thumbnail: image, video: meta(html, 'og:video:secure_url') || meta(html, 'og:video'), platform: label };
  });
  return { platform, info };
};
export const facebookDetails = ogDetails('facebook', 'Facebook');
export const instagramDetails = ogDetails('instagram', 'Instagram');

// ---------- MediaFire ----------
export function extractMediaFireLink(html) {
  const scr = html.match(/data-scrambled-url=["']([^"']+)["']/i)?.[1];
  if (scr) { try { const d = atob(scr); if (/^https?:\/\//.test(d)) return d; } catch { /* next pattern */ } }
  for (const re of [/<a[^>]+id=["']downloadButton["'][^>]+href=["'](https?:\/\/[^"']+)["']/i, /<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]+id=["']downloadButton["']/i,
    /<a[^>]+class=["'][^"']*download_link[^"']*["'][^>]+href=["']([^"']+)["']/i, /href=["'](https?:\/\/download[^"']+)["']/i]) {
    const m = html.match(re); if (m && /^https?:\/\//.test(m[1])) return decodeEntities(m[1]);
  }
  return null;
}
export async function mediafireResolve(p) {
  const url = safeUrl(p.url, 'mediafire');
  const result = await cached('mf:' + url, 600, async () => {
    const html = await page(url);
    const downloadUrl = extractMediaFireLink(html);
    if (!downloadUrl) throw new HttpError(404, 'Could not find the direct link (file removed or protected).');
    return { title: stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || 'MediaFire file'), downloadUrl };
  });
  return { result };
}

// ---------- Movies without a TMDB key (IMDb public suggestion + page data) ----------
export async function imdbSearch(q) {
  const key = q.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 60) || 'x';
  const d = await cached('imdbs:' + key, 21600, async () => {
    const r = await fetchT(`https://v3.sg.media-imdb.com/suggestion/${key[0]}/${encodeURIComponent(q)}.json`, { headers: { 'User-Agent': UA } }, 10000);
    if (!r.ok) throw new HttpError(502, 'Movie source is not answering right now.');
    return r.json();
  });
  const rows = (d.d || []).filter((x) => /^tt\d+$/.test(x.id));
  return { total: rows.length, page: 1, results: rows.map((x) => ({ id: x.id, type: /series/i.test(x.qid || x.q || '') ? 'tv' : 'movie', title: x.l, originalTitle: x.l, year: x.y ? String(x.y) : null, overview: null, rating: null, votes: 0, language: null, cast: x.s || null, poster: x.i?.imageUrl || null, backdrop: null })) };
}
export async function imdbDetails(id) {
  return cached('imdbd:' + id, 21600, async () => {
    const html = await page(`https://www.imdb.com/title/${id}/`, { 'Accept-Language': 'en-US,en;q=0.9' });
    const m = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/i);
    let ld; try { ld = JSON.parse(m?.[1] || ''); } catch { throw new HttpError(502, 'Movie source returned an unexpected page. Try again later.'); }
    const names = (x) => [].concat(x || []).map((a) => a.name).filter(Boolean);
    const dur = ld.duration?.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
    return {
      id, type: /TVSeries/i.test(ld['@type']) ? 'tv' : 'movie', title: decodeEntities(ld.name || ''), originalTitle: decodeEntities(ld.alternateName || ld.name || ''), year: (ld.datePublished || '').slice(0, 4) || null,
      overview: ld.description ? decodeEntities(ld.description) : null, rating: ld.aggregateRating?.ratingValue || null, votes: ld.aggregateRating?.ratingCount || 0, language: null,
      poster: ld.image || null, backdrop: null, tagline: null, genres: [].concat(ld.genre || []), runtimeMin: dur ? (Number(dur[1] || 0) * 60 + Number(dur[2] || 0)) || null : null,
      status: null, seasons: null, episodes: null, cast: names(ld.actor).slice(0, 10).map((name) => ({ name, character: null, photo: null })), directors: names(ld.director),
      trailer: ld.trailer?.url || null, homepage: `https://www.imdb.com/title/${id}/`
    };
  });
}
