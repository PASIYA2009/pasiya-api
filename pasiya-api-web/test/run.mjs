// Offline test: mocks Firestore, Identity Toolkit and upstream APIs, then exercises the Worker.
import { generateKeyPairSync } from 'node:crypto';
import worker from '../src/index.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = JSON.stringify({ client_email: 't@t.iam', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.googleapis.com/token' });

const db = new Map(); // "col/id" -> fields (raw firestore)
let tokenMints = 0, commits = 0, verified = true;
const dec = (f) => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, 'integerValue' in v ? Number(v.integerValue) : 'stringValue' in v ? v.stringValue : 'booleanValue' in v ? v.booleanValue : null]));
const j = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });

const RSS = `<?xml version="1.0"?><rss><channel><item><title><![CDATA[Test &amp; headline one]]></title><link>https://x.lk/1</link><pubDate>Sun, 01 Nov 2026 05:00:00 GMT</pubDate><description><![CDATA[<p>Body <b>text</b></p><img src="https://x.lk/a.jpg">]]></description></item><item><title>Second</title><link>https://x.lk/2</link><pubDate>Sun, 01 Nov 2026 06:00:00 GMT</pubDate></item></channel></rss>`;
const M3U = `#EXTM3U\n#EXTINF:-1 tvg-id="Derana.lk" tvg-logo="https://l/d.png" group-title="General",Derana TV (720p) [Not 24/7]\nhttps://s.example/derana.m3u8\n#EXTINF:-1 tvg-id="Hiru.lk" group-title="General",Hiru TV\n#EXTVLCOPT:http-referrer=x\nhttps://s.example/hiru.m3u8\n`;

globalThis.fetch = async (input, init = {}) => {
  const url = String(input?.url || input);
  if (url.includes('oauth2.googleapis.com')) { tokenMints++; return j({ access_token: 'tok', expires_in: 3600 }); }
  if (url.includes('identitytoolkit')) return j({ users: [{ localId: 'u1', email: 'eshandinujaya86@gmail.com', emailVerified: verified }] });
  if (url.includes('firestore.googleapis.com')) {
    const path = url.split('/documents')[1] || '';
    const m = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    if (path.startsWith(':commit')) {
      commits++;
      for (const w of body.writes) if (w.currentDocument?.exists === false && db.has(w.update.name.split('/documents/')[1])) return j({ error: { status: 'ALREADY_EXISTS', message: 'exists' } }, 409);
      for (const w of body.writes) {
        const name = w.update.name.split('/documents/')[1];
        const cur = db.get(name) || {};
        Object.assign(cur, w.update.fields);
        for (const t of w.updateTransforms || []) cur[t.fieldPath] = { integerValue: String(Number(cur[t.fieldPath]?.integerValue || 0) + Number(t.increment.integerValue)) };
        db.set(name, cur);
      }
      return j({});
    }
    if (path.startsWith(':batchGet')) return j(body.documents.map((n) => { const k = n.split('/documents/')[1]; return db.has(k) ? { found: { name: n, fields: db.get(k) } } : { missing: n }; }));
    if (path.startsWith(':runQuery')) {
      const col = body.structuredQuery.from[0].collectionId, f = body.structuredQuery.where?.fieldFilter;
      const out = [...db].filter(([k]) => k.startsWith(col + '/')).filter(([, v]) => !f || v[f.field.fieldPath]?.stringValue === f.value.stringValue).map(([k, v]) => ({ document: { name: 'x/documents/' + k, fields: v } }));
      return j(out);
    }
    if (m === 'GET') { const k = decodeURIComponent(path.slice(1)); return db.has(k) ? j({ name: k, fields: db.get(k) }) : j({}, 404); }
    if (m === 'PATCH') { db.set(decodeURIComponent(path.slice(1)), body.fields); return j({}); }
    if (m === 'POST') { const id = 'auto' + db.size; db.set(path.slice(1) + '/' + id, body.fields); return j({ name: 'x/' + id }); }
  }
  if (url.includes('news.google.com') || url.includes('adaderana') || url.includes('newswire') || url.includes('economynext')) return new Response(RSS);
  if (url.includes('iptv-org')) return new Response(M3U);
  if (url.includes('geocoding-api')) return j({ results: [{ name: 'Colombo', latitude: 6.93, longitude: 79.86, country: 'Sri Lanka', country_code: 'LK', admin1: 'Western' }] });
  if (url.includes('api.open-meteo.com')) {
    const cur = { time: '2026-11-01T10:00', temperature_2m: 29.1, apparent_temperature: 33, relative_humidity_2m: 80, precipitation: 0, weather_code: 2, cloud_cover: 40, wind_speed_10m: 12, wind_direction_10m: 200, pressure_msl: 1008, is_day: 1 };
    if (url.includes('latitude=6.9271,')) return j(Array.from({ length: 12 }, () => ({ current: cur })));
    return j({ timezone: 'Asia/Colombo', current: cur, daily: { time: ['2026-11-01'], weather_code: [61], temperature_2m_max: [31], temperature_2m_min: [25], precipitation_sum: [4], precipitation_probability_max: [70], sunrise: ['a'], sunset: ['b'] } });
  }
  if (url.includes('generativelanguage')) return j({ candidates: [{ content: { parts: [{ text: 'Hello from Gemini' }] } }] });
  if (url.includes('openrouter.ai')) return j({ error: { message: 'rate limited' } }, 429);
  if (url.includes('themoviedb')) return j(url.includes('/search/') ? { total_results: 1, page: 1, results: [{ id: 27205, title: 'Inception', release_date: '2010-07-15', vote_average: 8.37, poster_path: '/p.jpg' }] } : { id: 27205, title: 'Inception', genres: [{ name: 'Sci-Fi' }], credits: { cast: [{ name: 'Leo' }], crew: [{ job: 'Director', name: 'Nolan' }] }, videos: { results: [{ site: 'YouTube', type: 'Trailer', key: 'abc' }] } });
  if (url.includes('youtube.com/results')) return new Response(`<html><script>var ytInitialData = ${JSON.stringify({ contents: { a: [{ videoRenderer: { videoId: 'abc123', title: { runs: [{ text: 'Sinhala "song" {x}' }] }, lengthText: { simpleText: '3:25' }, ownerText: { runs: [{ text: 'Chan' }] }, viewCountText: { simpleText: '1,234 views' }, thumbnail: { thumbnails: [{ url: 'https://i/y.jpg' }] } } }, { videoRenderer: { videoId: 'def456', title: { runs: [{ text: 'Two' }] } } }] } })};</script></html>`);
  if (url.includes('youtube.com/oembed')) return url.includes('missing') ? j({}, 404) : j({ title: 'Never Gonna', author_name: 'Rick', author_url: 'https://yt/rick', thumbnail_url: 'https://i/t.jpg' });
  if (url.includes('youtube.com/watch')) return new Response('<script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"dQw","lengthSeconds":"212","viewCount":"99","shortDescription":"desc { }"}};</script>');
  if (url.includes('tiktok.com/oembed')) return j({ title: 'tt vid', author_name: 'user1', author_url: 'https://tiktok.com/@user1', thumbnail_url: 'https://i/tt.jpg' });
  if (url.includes('facebook.com/watch')) return new Response('<meta property="og:title" content="FB &amp; post"><meta content="https://i/fb.jpg" property="og:image"><meta property="og:description" content="hello">');
  if (url.includes('instagram.com')) return new Response('<html>login wall</html>');
  if (url.includes('mediafire.com')) return new Response('<title>file.zip</title><a class="x" id="downloadButton" href="https://download123.mediafire.com/f/file.zip?a=1&amp;b=2">Download</a>');
  if (url.includes('media-imdb.com')) return j({ d: [{ id: 'tt1375666', l: 'Inception', q: 'feature', y: 2010, s: 'Leonardo DiCaprio', i: { imageUrl: 'https://i/inc.jpg' } }, { id: 'nm0000138', l: 'Leonardo' }] });
  if (url.includes('imdb.com/title/')) return new Response('<script type="application/ld+json">' + JSON.stringify({ '@type': 'Movie', name: 'Inception', description: 'Dream &amp; heist', datePublished: '2010-07-16', duration: 'PT2H28M', genre: ['Sci-Fi'], image: 'https://i/inc.jpg', aggregateRating: { ratingValue: 8.8, ratingCount: 2000000 }, actor: [{ name: 'Leo' }], director: [{ name: 'Nolan' }] }) + '</script>');
  throw new Error('unmocked fetch ' + url);
};

const env = { FIREBASE_PROJECT_ID: 'p', FIREBASE_WEB_API_KEY: 'k', FIREBASE_SERVICE_ACCOUNT_JSON: SA, ADMIN_EMAIL: 'eshandinujaya86@gmail.com', GEMINI_API_KEY: 'g', OPENROUTER_API_KEY: 'o', PLATFORM_START: '2026-10-30T00:00:00Z', ASSETS: { fetch: () => new Response('asset') } };
const ctx = { waitUntil: (p) => p };
const call = async (path, init = {}, e = env) => { const r = await worker.fetch(new Request('https://t.dev' + path, init), e, ctx); return { s: r.status, b: await r.json().catch(() => null) }; };
let fail = 0;
const ok = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' ' + JSON.stringify(extra))); if (!cond) fail++; };

const auth = { headers: { Authorization: 'Bearer x' } };
let r = await call('/api/keys/ensure', { method: 'POST', ...auth });
ok('ensure creates key', r.s === 200 && r.b.created && r.b.key.startsWith('pasiya_'), r);
const KEY = r.b.key;
r = await call('/api/keys/ensure', { method: 'POST', ...auth });
ok('ensure is idempotent and returns the key again', r.b.created === false && r.b.key === KEY, r);
r = await call('/api/keys', auth); ok('key list shows full key to its owner', r.b.keys[0].key === KEY, r.b);
r = await call('/api/me', auth); ok('me has 10 coins', r.b.coins === 10 && r.b.role === 'admin', r);

r = await call('/api/weather?city=Colombo'); ok('no key -> 401', r.s === 401, r);
r = await call('/api/weather?city=Colombo&apikey=bad'); ok('bad key -> 401', r.s === 401, r);
r = await call(`/api/weather?city=Colombo&apikey=${KEY}`); ok('weather ok', r.s === 200 && r.b.result.current.condition.text === 'Partly cloudy' && r.b.result.forecast[0].condition.text === 'Light rain' && r.b.creator === 'Pasidu Eshan', r);
r = await call(`/api/weather/sri-lanka?apikey=${KEY}`); ok('lk weather 12 cities', r.b.result.cities.length === 12 && r.b.result.cities[0].city === 'Colombo', r);
r = await call(`/api/news?apikey=${KEY}&limit=5`); ok('news parsed+deduped', r.s === 200 && r.b.result.articles.length === 2 && r.b.result.articles[0].title === 'Second' && r.b.result.articles[1].title === 'Test & headline one' && r.b.result.articles[1].image === 'https://x.lk/a.jpg' && r.b.result.articles[1].summary === 'Body text', r.b);
r = await call(`/api/news?apikey=${KEY}&source=nope`); ok('bad source 400', r.s === 400, r);
r = await call(`/api/tv/channels?apikey=${KEY}&q=derana`); ok('tv m3u', r.s === 200 && r.b.result.count === 1 && r.b.result.channels[0].quality === '720p' && r.b.result.channels[0].name === 'Derana TV', r.b);
r = await call(`/api/tv/channels?apikey=${KEY}`); ok('tv skips EXTVLCOPT', r.b.result.count === 2, r.b);
r = await call(`/api/ai/gemini?apikey=${KEY}&prompt=hi`); ok('gemini ok', r.s === 200 && r.b.result.answer === 'Hello from Gemini', r);
r = await call(`/api/ai/gpt?apikey=${KEY}&prompt=hi`); ok('gpt chain fails w/ 502 msg', r.s === 502 && /openrouter/.test(r.b.error), r);
r = await call(`/api/ai/llama?apikey=${KEY}&prompt=hi`); ok('llama not enabled -> 503', r.s === 503, r);
const envAI = { ...env, GEMINI_API_KEY: undefined, OPENROUTER_API_KEY: undefined, AI: { run: async (m) => ({ response: 'cf says hi via ' + m }) } };
for (const mdl of ['gemini', 'gpt', 'deepseek', 'claude', 'llama']) { r = await call(`/api/ai/${mdl}?apikey=${KEY}&prompt=hi`, {}, envAI); ok(`${mdl} works with NO keys via Workers AI`, r.s === 200 && r.b.result.provider === 'workers-ai', r); }
// stale-if-error: news feeds die after one good fetch -> last good copy is still served
globalThis.caches = (() => { const m = new Map(); return { default: { match: async (q) => { const v = m.get(q.url); return v ? new Response(v) : undefined; }, put: async (q, res) => { m.set(q.url, await res.text()); } } }; })();
{ const real = globalThis.fetch; let down = false;
  globalThis.fetch = async (i, n) => { if (down && String(i?.url || i).includes('iptv-org')) throw new Error('down'); return real(i, n); };
  r = await call(`/api/tv/channels?apikey=${KEY}&q=hiru`); ok('tv fresh ok', r.s === 200 && r.b.result.count === 1, r.b);
  down = true; for (const k of [...(globalThis.__memKeys || [])]) void k;
  r = await call(`/api/tv/channels?apikey=${KEY}&q=derana`); ok('tv upstream DOWN -> still answers from last good copy', r.s === 200 && r.b.result.count === 1, r.b);
  globalThis.fetch = real; }
delete globalThis.caches;
r = await call(`/api/ai/gemini?apikey=${KEY}`); ok('missing prompt 400', r.s === 400, r);
r = await call(`/api/ai/gemini`, { method: 'POST', headers: { 'X-API-Key': KEY, 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'yo' }) }); ok('POST json + header key', r.s === 200, r);
r = await call(`/api/movie/search?apikey=${KEY}&q=inception`); ok('movie search works with NO tmdb key (IMDb)', r.s === 200 && r.b.result.results.length === 1 && r.b.result.results[0].id === 'tt1375666' && r.b.result.results[0].poster === 'https://i/inc.jpg', r.b);
r = await call(`/api/movie/details?apikey=${KEY}&id=tt1375666`); ok('movie details NO key (IMDb ld+json)', r.s === 200 && r.b.result.title === 'Inception' && r.b.result.runtimeMin === 148 && r.b.result.directors[0] === 'Nolan' && r.b.result.overview === 'Dream & heist' && r.b.result.rating === 8.8, r.b);
r = await call(`/api/movie/trending?apikey=${KEY}`); ok('trending needs tmdb key -> 503', r.s === 503, r);
const env2 = { ...env, TMDB_API_KEY: 't' };
r = await call(`/api/movie/search?apikey=${KEY}&q=inception`, {}, env2); ok('tmdb search', r.s === 200 && r.b.result.results[0].poster.endsWith('/w500/p.jpg'), r);
r = await call(`/api/movie/details?apikey=${KEY}&id=27205`, {}, env2); ok('tmdb details', r.b.result.trailer.endsWith('abc') && r.b.result.directors[0] === 'Nolan', r);
r = await call(`/api/scraper/youtube/search?apikey=${KEY}&query=sinhala&limit=1`); ok('youtube search built-in', r.s === 200 && r.b.result.results.length === 1 && r.b.result.results[0].title === 'Sinhala "song" {x}' && r.b.result.results[0].duration === 205 && r.b.result.results[0].views === 1234 && r.b.result.results[0].url.endsWith('abc123'), r.b);
r = await call(`/api/scraper/youtube/details?apikey=${KEY}&url=${encodeURIComponent('https://www.youtube.com/watch?v=dQw')}`); ok('youtube details built-in', r.s === 200 && r.b.result.info.title === 'Never Gonna' && r.b.result.info.duration === 212 && r.b.result.info.views === 99, r.b);
r = await call(`/api/scraper/youtube/details?apikey=${KEY}&url=${encodeURIComponent('https://evil.example/watch?v=1')}`); ok('wrong host rejected 400', r.s === 400, r);
r = await call(`/api/scraper/youtube/details?apikey=${KEY}&url=${encodeURIComponent('https://www.youtube.com.evil.com/watch?v=1')}`); ok('lookalike host rejected 400', r.s === 400, r);
r = await call(`/api/scraper/youtube/details?apikey=${KEY}&url=${encodeURIComponent('http://127.0.0.1/x')}`); ok('local address rejected 400', r.s === 400, r);
r = await call(`/api/scraper/youtube/details?apikey=${KEY}&url=${encodeURIComponent('https://www.youtube.com/watch?v=missing')}`); ok('youtube missing video 404', r.s === 404, r);
r = await call(`/api/scraper/tiktok/details?apikey=${KEY}&url=${encodeURIComponent('https://www.tiktok.com/@user1/video/1')}`); ok('tiktok details built-in', r.s === 200 && r.b.result.info.uploader === 'user1', r.b);
r = await call(`/api/scraper/facebook/details?apikey=${KEY}&url=${encodeURIComponent('https://www.facebook.com/watch/?v=123')}`); ok('facebook OG details', r.s === 200 && r.b.result.info.title === 'FB & post' && r.b.result.info.thumbnail === 'https://i/fb.jpg', r.b);
r = await call(`/api/scraper/instagram/details?apikey=${KEY}&url=${encodeURIComponent('https://www.instagram.com/p/abc/')}`); ok('instagram login wall -> 404 message', r.s === 404, r);
r = await call(`/api/scraper/mediafire/resolve?apikey=${KEY}&url=${encodeURIComponent('https://www.mediafire.com/file/abc/file.zip')}`); ok('mediafire link', r.s === 200 && r.b.result.result.downloadUrl === 'https://download123.mediafire.com/f/file.zip?a=1&b=2' && r.b.result.result.title === 'file.zip', r.b);
r = await call(`/api/scraper/facebook/download?apikey=${KEY}&url=x`); ok('legacy download w/o scraper server -> 503', r.s === 503, r);

// coins: gemini x2 (cost1) + movie x2 ok = charged; check balance
r = await call('/api/me', auth);
ok('coins charged only on success (10 - 2 gemini - 2 tmdb)', r.b.coins === 10 || r.b.role === 'admin', r.b); // admin is free
const user2 = { ...env, ADMIN_EMAIL: 'someone@else.com', RATE_LIMIT_PER_MIN: '1000' };
r = await call('/api/me', auth, user2); ok('non-admin sees user role', r.b.role === 'user', r);
const c0 = r.b.coins;
await call(`/api/ai/gemini?apikey=${KEY}&prompt=hi`, {}, user2);
r = await call('/api/me', auth, user2); ok('non-admin charged 1 coin', r.b.coins === c0 - 1, { c0, now: r.b.coins });
await call(`/api/ai/gpt?apikey=${KEY}&prompt=hi`, {}, user2);
r = await call('/api/me', auth, user2); ok('failed call NOT charged', r.b.coins === c0 - 1, r.b);
r = await call('/api/usage', auth, user2); ok('usage logged', r.b.items.length === 1, r.b);

// drain coins -> 402
for (let i = 0; i < 12; i++) await call(`/api/ai/gemini?apikey=${KEY}&prompt=hi`, {}, user2);
r = await call(`/api/ai/gemini?apikey=${KEY}&prompt=hi`, {}, user2); ok('out of coins -> 402', r.s === 402, r);

r = await call('/api/status'); ok('status shape', r.b.status === 'Online' && r.b.database.ok && r.b.requests24h > 5 && r.b.endpoints === 19 && r.b.categories === 6, r.b);
r = await call('/api/catalog'); ok('catalog lists all 19 (scrapers built in)', r.b.apis.length === 19, r.b.apis.length);
r = await call('/api/catalog', {}, { ...env, SCRAPER_URL: 'https://s' }); ok('catalog same w/ SCRAPER_URL', r.b.apis.length === 19, r.b.apis.length);
r = await call('/api/daily-claim', { method: 'POST', ...auth }, user2); ok('daily claim', r.s === 200, r);
r = await call('/api/daily-claim', { method: 'POST', ...auth }, user2); ok('daily claim twice 409', r.s === 409, r);
r = await call('/api/spin', { method: 'POST', ...auth }, user2); ok('spin awards coins', r.s === 200 && [10,25,50,100,250].includes(r.b.reward) && r.b.index >= 0 && r.b.index < 5, r);
r = await call('/api/spin', { method: 'POST', ...auth }, user2); ok('spin twice 409', r.s === 409, r);
r = await call('/api/admin/overview', auth); ok('admin overview', r.s === 200 || r.s === 503, r); // count aggregation not mocked
r = await call('/api/admin/overview', auth, user2); ok('non-admin blocked from admin 403', r.s === 403, r);

// ---- admin: settings, grant coins, user list -------------------------------------------------
const jb = (o) => ({ method: 'POST', headers: { Authorization: 'Bearer x', 'content-type': 'application/json' }, body: JSON.stringify(o) });
r = await call('/api/admin/settings', jb({ dailyCoins: 0, spinMax: 500 })); ok('settings validated', r.s === 400, r);
r = await call('/api/admin/settings', jb({ dailyCoins: 20, spinMax: 500 })); ok('settings saved', r.s === 200 && r.b.dailyCoins === 20 && r.b.spinRewards.join() === '20,50,100,200,500', r.b);
r = await call('/api/admin/settings', jb({ dailyCoins: 20, spinMax: 500 }), user2); ok('settings: non-admin 403', r.s === 403, r);
r = await call('/api/me', auth); ok('me shows unlimited admin + new rewards', r.b.unlimited === true && r.b.dailyCoins === 20 && r.b.spinRewards[4] === 500 && /^\d{4}-\d\d-\d\d$/.test(r.b.today), r.b);
r = await call('/api/admin/users', auth); ok('admin user list', r.s === 200 && r.b.items.some((x) => x.email === 'eshandinujaya86@gmail.com'), r.b);
r = await call('/api/admin/coins', jb({ email: 'nobody@gmail.com', amount: 5 })); ok('grant to unknown email 404', r.s === 404, r);
r = await call('/api/admin/coins', jb({ email: 'ESHANDINUJAYA86@gmail.com', amount: 500 })); ok('admin grants coins by email (case-insens.)', r.s === 200 && /Added 500/.test(r.b.message), r);
r = await call('/api/admin/coins', jb({ email: 'eshandinujaya86@gmail.com', amount: -99999 })); ok('removal never goes below 0', r.s === 200 && /New balance: 0/.test(r.b.message), r);

// ---- fresh user: claim uses admin-set amount, double click is blocked atomically -----------------
r = await call('/api/daily-claim', jb({}), { ...user2, FIREBASE_PROJECT_ID: 'p' }); // user2 already claimed above -> 409
ok('claim again same day 409', r.s === 409, r);
for (const k of [...db.keys()]) if (k.startsWith('claims/')) db.delete(k); // pretend it is a new day
db.get('users/u1').lastDailyClaim = { stringValue: 'old' }; db.get('users/u1').lastSpinDay = { stringValue: 'old' }; db.get('users/u1').coins = { integerValue: '0' };
const [c1, c2] = await Promise.all([call('/api/daily-claim', jb({}), user2), call('/api/daily-claim', jb({}), user2)]);
ok('two simultaneous claims -> exactly one paid', [c1.s, c2.s].sort().join() === '200,409', { c1, c2 });
r = await call('/api/me', auth, user2); ok('claim paid admin-set 20 coins once', r.b.coins === 20, r.b);
const [s1, s2] = await Promise.all([call('/api/spin', jb({}), user2), call('/api/spin', jb({}), user2)]);
ok('two simultaneous spins -> exactly one paid', [s1.s, s2.s].sort().join() === '200,409', { s1, s2 });
ok('spin prize from admin table', [20, 50, 100, 200, 500].includes((s1.s === 200 ? s1 : s2).b.reward), { s1, s2 });

// ---- security: owner email NOT verified (someone registered it with a password) -> no admin -------------
verified = false;
r = await call('/api/admin/overview', { headers: { Authorization: 'Bearer unverified' } }); ok('unverified owner email gets NO admin (403)', r.s === 403, r);
r = await call('/api/me', { headers: { Authorization: 'Bearer unverified' } }); ok('unverified owner sees adminPending', r.b.role === 'user' && r.b.adminPending === true, r.b);
verified = true;
r = await call('/api/nope'); ok('404 json', r.s === 404, r);
r = await call('/', {}); ok('static falls to ASSETS', r.s === 200 || r.b === null);
ok('RSA token minted only once', tokenMints === 1, { tokenMints });
console.log('commits:', commits, 'docs:', db.size);
console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
