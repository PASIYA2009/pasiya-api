// Sri Lanka news from public RSS feeds. Each feed is fetched on its own, so one broken feed never breaks the answer.
import { HttpError, fetchT, cached, clamp, stripHtml, decodeEntities } from '../lib/util.js';

export const SOURCES = {
  'google-en': { name: 'Google News (Sri Lanka, English)', lang: 'en', url: 'https://news.google.com/rss?hl=en-LK&gl=LK&ceid=LK:en' },
  'google-si': { name: 'Google News (Sri Lanka, සිංහල)', lang: 'si', url: 'https://news.google.com/rss?hl=si&gl=LK&ceid=LK:si' },
  'adaderana': { name: 'Ada Derana', lang: 'en', url: 'https://www.adaderana.lk/rss.php' },
  'hirunews': { name: 'Hiru News', lang: 'en', url: 'https://www.hirunews.lk/rss/english.xml' },
  'newswire': { name: 'Newswire', lang: 'en', url: 'https://www.newswire.lk/feed/' },
  'economynext': { name: 'EconomyNext', lang: 'en', url: 'https://economynext.com/feed/' },
  'colombogazette': { name: 'Colombo Gazette', lang: 'en', url: 'https://colombogazette.com/feed/' }
};
const DEFAULT_SET = ['google-en', 'adaderana', 'newswire', 'economynext'];

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1].replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '').trim() : '';
};

export function parseRss(xml, limit = 30) {
  const items = [];
  const re = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) && items.length < limit) {
    const b = m[1];
    const rawDesc = tag(b, 'description') || tag(b, 'content:encoded');
    const link = decodeEntities(tag(b, 'link') || (b.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? ''));
    const img = b.match(/<(?:media:content|media:thumbnail|enclosure)[^>]*url=["']([^"']+)["']/i)?.[1]
      || decodeEntities(rawDesc).match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] || null;
    const d = new Date(tag(b, 'pubDate') || tag(b, 'dc:date'));
    const title = stripHtml(tag(b, 'title'));
    if (!title || !link) continue;
    items.push({
      title, link, image: img ? decodeEntities(img) : null,
      summary: stripHtml(rawDesc).slice(0, 280) || null,
      publishedAt: isNaN(d) ? null : d.toISOString()
    });
  }
  return items;
}

async function feed(id) {
  const s = SOURCES[id];
  return cached('news:' + id, 300, async () => {
    const r = await fetchT(s.url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PASIYA-API/2.0)', Accept: 'application/rss+xml,application/xml,text/xml,*/*' } }, 10000);
    if (!r.ok) throw new HttpError(502, `${s.name} answered HTTP ${r.status}`);
    return parseRss(await r.text(), 40).map((x) => ({ ...x, source: s.name, sourceId: id }));
  });
}

export async function latest(p) {
  const limit = clamp(p.limit, 1, 30, 10);
  const q = String(p.q || '').trim().toLowerCase().slice(0, 60);
  const want = String(p.source || '').toLowerCase();
  const ids = want && want !== 'all' ? want.split(',').map((x) => x.trim()).filter(Boolean) : DEFAULT_SET;
  const bad = ids.find((i) => !SOURCES[i]);
  if (bad) throw new HttpError(400, `Unknown source "${bad}". Use one of: ${Object.keys(SOURCES).join(', ')}`);
  const settled = await Promise.allSettled(ids.slice(0, 5).map(feed));
  const errors = [];
  let items = [];
  settled.forEach((s, i) => s.status === 'fulfilled' ? items.push(...s.value) : errors.push({ source: ids[i], error: s.reason?.message || 'failed' }));
  if (!items.length) throw new HttpError(502, 'No news source answered. ' + errors.map((e) => `${e.source}: ${e.error}`).join('; '));
  if (q) items = items.filter((x) => x.title.toLowerCase().includes(q) || (x.summary || '').toLowerCase().includes(q));
  items.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
  const seen = new Set();
  items = items.filter((x) => { const k = x.title.toLowerCase().slice(0, 60); return seen.has(k) ? false : seen.add(k); });
  return { count: Math.min(items.length, limit), articles: items.slice(0, limit), ...(errors.length ? { unavailable: errors } : {}) };
}

export const sources = () => ({ sources: Object.entries(SOURCES).map(([id, s]) => ({ id, name: s.name, language: s.lang })) });
