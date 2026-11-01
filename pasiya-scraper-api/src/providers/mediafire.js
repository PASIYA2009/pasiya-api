export function isMediaFireUrl(input) {
  try { return /(^|\.)mediafire\.com$/i.test(new URL(input).hostname); } catch { return false; }
}
export function getMediaFireUrl(input) { return isMediaFireUrl(input) ? input : null; }

export function extractMediaFireLink(html) {
  // 1) Newer pages hide the link base64-encoded
  const scr = html.match(/data-scrambled-url=["']([^"']+)["']/i)?.[1];
  if (scr) { try { const d = Buffer.from(scr, 'base64').toString('utf8'); if (/^https?:\/\//.test(d)) return d; } catch {} }
  // 2) Classic patterns
  const patterns = [
    /<a[^>]+id=["']downloadButton["'][^>]+href=["'](https?:\/\/[^"']+)["']/i,
    /<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]+id=["']downloadButton["']/i,
    /<a[^>]+class=["'][^"']*download_link[^"']*["'][^>]+href=["']([^"']+)["']/i,
    /href=["'](https?:\/\/download[^"']+)["']/i
  ];
  for (const p of patterns) { const m = html.match(p); if (m && /^https?:\/\//.test(m[1])) return m[1].replace(/&amp;/g, '&'); }
  return null;
}

export async function scrapeMediaFire(input) {
  if (!isMediaFireUrl(input)) throw new Error('Invalid MediaFire URL.');
  const res = await fetch(input, {
    redirect: 'follow',
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36' },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`MediaFire HTTP ${res.status}`);
  const html = await res.text();
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || 'MediaFire file').replace(/\s+/g, ' ').trim();
  const downloadUrl = extractMediaFireLink(html);
  if (!downloadUrl) throw new Error('Could not find the MediaFire direct download link (file removed or protected).');
  return { title, downloadUrl };
}
