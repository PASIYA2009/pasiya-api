// SinhalaSub movie search / details / download links (supunofc.site API).
// Requires an explicit SINHALASUB_API_KEY environment variable.

const API = String(process.env.SINHALASUB_API_URL || 'https://supunofc.site/api/movie/sinhalasub').replace(/\/+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TIMEOUT = { search: 45000, details: 90000, dl: 120000 };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HEADER_SETS = [
  { accept: 'application/json, text/plain, */*', 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' },
  { accept: 'application/json, text/plain, */*', 'user-agent': UA, referer: 'https://supunofc.site/' },
  { accept: '*/*', 'user-agent': 'curl/8.5.0' }
];
export const SS_REFERER = 'https://sinhalasub.lk/';

function key() {
  const k = process.env.SINHALASUB_API_KEY;
  return String(k || '').trim().replace(/^["']+|["']+$/g, '').trim();
}

async function api(path, params) {
  const k = key();
  if (!k) throw new Error('SinhalaSub API key is not set. Owner: add SINHALASUB_API_KEY in the environment variables.');
  const qs = Object.entries({ ...params, apikey: k }).map(([a, b]) => `${a}=${encodeURIComponent(b)}`).join('&');
  let lastErr;
  for (let attempt = 0; attempt < HEADER_SETS.length; attempt++) {
    if (attempt) await sleep(2000 * attempt);
    let res, text;
    try {
      res = await fetch(`${API}/${path}?${qs}`, { headers: HEADER_SETS[attempt], signal: AbortSignal.timeout(TIMEOUT[path] || 60000) });
      text = await res.text();
    } catch (e) {
      lastErr = new Error(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'SinhalaSub API took too long to answer. Try again in a moment.' : `Could not reach the SinhalaSub API (${e?.cause?.code || e?.message || 'network error'}).`);
      continue;
    }
    let json;
    try { json = JSON.parse(text); } catch {
      lastErr = new Error(`SinhalaSub API returned an invalid response (HTTP ${res.status}).`);
      continue;
    }
    if (!res.ok || json?.success === false || json?.error) {
      lastErr = new Error(`${json?.message || (typeof json?.error === 'string' ? json.error : '') || 'SinhalaSub API error'} (HTTP ${res.status})`);
      if (res.status >= 500 || res.status === 403 || res.status === 429) continue;
      throw lastErr;
    }
    const result = json?.result ?? json?.data;
    if (result == null) throw new Error('SinhalaSub API returned no data.');
    return result;
  }
  throw lastErr;
}

export const ssTitle = (t) => String(t || '').split('|')[0].replace(/\s*Sinhala Subtitles\s*/i, ' ').replace(/\s+/g, ' ').trim();

export async function ssSearch(q) {
  const r = await api('search', { q });
  const list = Array.isArray(r) ? r : (r?.results || []);
  return list.filter((x) => x?.url).map((x) => ({ title: x.title, year: x.year, type: x.type, url: x.url, image: x.image, language: x.language, quality: x.quality, resolution: x.resolution }));
}

// Server preference when the same quality exists on several servers (first = tried first).
const SERVER_ORDER = ['dlserver-01', 'dlserver-02', 'dotflix', 'telagram'];
const serverRank = (s) => { const i = SERVER_ORDER.indexOf(String(s || '').toLowerCase()); return i < 0 ? 99 : i; };

// "FHD 1080p" -> 1080 ; "3.39 GB" -> MB
const qNum = (q) => Number(String(q).match(/(\d{3,4})p/i)?.[1] || 0);
const sizeMB = (s) => { const m = String(s || '').match(/([\d.]+)\s*(GB|MB)/i); return m ? Math.round(parseFloat(m[1]) * (/gb/i.test(m[2]) ? 1024 : 1)) : 0; };

export async function ssDetails(url) {
  const d = await api('details', { url });
  if (!d || typeof d !== 'object') throw new Error('SinhalaSub API returned no details for this title.');
  // one entry per quality, each with its mirror pages ordered by server preference
  const byQ = new Map();
  for (const x of Array.isArray(d.downloads) ? d.downloads : []) {
    if (!x?.url) continue;
    const q = qNum(x.quality) ? `${qNum(x.quality)}p` : String(x.quality || 'File');
    if (!byQ.has(q)) byQ.set(q, { quality: q, label: String(x.quality || q), size: x.size || '', sizeMB: sizeMB(x.size), pages: [] });
    byQ.get(q).pages.push({ server: x.server, url: x.url, rank: serverRank(x.server) });
  }
  const links = [...byQ.values()].map((l) => ({ ...l, pages: l.pages.sort((a, b) => a.rank - b.rank) })).sort((a, b) => qNum(a.quality) - qNum(b.quality));
  return { ...d, links };
}

// Resolves one "links" page to the direct file URL. Returns { url, fileName } or null.
export async function ssDirect(pageUrl) {
  const r = await api('dl', { url: pageUrl });
  const url = r?.downloadUrl || r?.url || (Array.isArray(r?.mirrors) ? r.mirrors.find((m) => m?.url)?.url : '') || '';
  if (!/^https?:\/\//i.test(url)) return null;
  return { url, fileName: r?.fileName || '' };
}
