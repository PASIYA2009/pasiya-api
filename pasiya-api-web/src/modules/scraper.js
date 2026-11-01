// Forwards a request to the optional Node scraper service (yt-dlp etc.). The shared secret never leaves the Worker.
import { HttpError, fetchT } from '../lib/util.js';

export const forward = (upstreamPath) => async (p, env) => {
  if (!env.SCRAPER_URL || !env.SCRAPER_SHARED_SECRET) throw new HttpError(503, 'Social scraper service is not connected on this server.');
  const r = await fetchT(env.SCRAPER_URL.replace(/\/$/, '') + upstreamPath, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': env.SCRAPER_SHARED_SECRET }, body: JSON.stringify(p)
  }, 60000);
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.success === false) throw new HttpError(r.status >= 400 && r.status < 600 ? r.status : 502, d.error || 'Scraper request failed.');
  const { success, ...rest } = d;
  return rest;
};
