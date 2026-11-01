// Movie & TV metadata. With a free TMDB key (TMDB_API_KEY / TMDB_READ_TOKEN) TMDB is used; with NO key the built-in
// keyless IMDb lookup answers search + details (ids look like tt1375666). Trending needs the TMDB key.
import { HttpError, fetchT, cached, clamp } from '../lib/util.js';
import { imdbSearch, imdbDetails } from './builtin.js';
const hasTmdb = (env) => !!(env.TMDB_API_KEY || env.TMDB_READ_TOKEN);

const IMG = 'https://image.tmdb.org/t/p/';
async function tmdb(env, path, qs = {}) {
  if (!env.TMDB_API_KEY && !env.TMDB_READ_TOKEN) throw new HttpError(503, 'Movie API is not enabled. The owner must add TMDB_API_KEY (free at themoviedb.org).');
  const u = new URL('https://api.themoviedb.org/3' + path);
  for (const [k, v] of Object.entries(qs)) if (v !== undefined && v !== '') u.searchParams.set(k, v);
  if (!env.TMDB_READ_TOKEN) u.searchParams.set('api_key', env.TMDB_API_KEY);
  const key = u.pathname + u.search.replace(/api_key=[^&]+/, '');
  return cached('tmdb:' + key, 21600, async () => {
    const r = await fetchT(u, env.TMDB_READ_TOKEN ? { headers: { Authorization: `Bearer ${env.TMDB_READ_TOKEN}` } } : {});
    if (r.status === 404) throw new HttpError(404, 'Not found.');
    if (!r.ok) throw new HttpError(502, 'Movie service error.');
    return r.json();
  });
}
const type = (p) => (String(p.type || 'movie').toLowerCase() === 'tv' ? 'tv' : 'movie');
const card = (x, t) => ({
  id: x.id, type: t, title: x.title || x.name, originalTitle: x.original_title || x.original_name,
  year: (x.release_date || x.first_air_date || '').slice(0, 4) || null, overview: x.overview || null,
  rating: x.vote_average ? Math.round(x.vote_average * 10) / 10 : null, votes: x.vote_count || 0, language: x.original_language,
  poster: x.poster_path ? IMG + 'w500' + x.poster_path : null, backdrop: x.backdrop_path ? IMG + 'w780' + x.backdrop_path : null
});

export async function search(p, env) {
  const q = String(p.q || p.query || '').trim();
  if (!q || q.length > 100) throw new HttpError(400, 'q is required (example: ?q=Inception).');
  if (!hasTmdb(env)) return imdbSearch(q);
  const t = type(p);
  const d = await tmdb(env, `/search/${t}`, { query: q, year: p.year, language: p.lang || 'en-US', page: clamp(p.page, 1, 20, 1), include_adult: 'false' });
  return { total: d.total_results, page: d.page, results: (d.results || []).slice(0, 15).map((x) => card(x, t)) };
}

export async function details(p, env) {
  const imdb = String(p.id || '').trim().match(/^tt\d{5,10}$/)?.[0];
  if (imdb && !hasTmdb(env)) return imdbDetails(imdb);
  if (imdb) throw new HttpError(400, 'This is an IMDb id (tt...). Search again to get a TMDB id, or remove the TMDB key to use IMDb ids.');
  const id = clamp(p.id, 1, 1e9, 0);
  if (!id) throw new HttpError(400, 'id is required (get it from /api/movie/search).');
  const t = type(p);
  const d = await tmdb(env, `/${t}/${id}`, { language: p.lang || 'en-US', append_to_response: 'credits,videos' });
  const trailer = (d.videos?.results || []).find((v) => v.site === 'YouTube' && v.type === 'Trailer') || (d.videos?.results || []).find((v) => v.site === 'YouTube');
  return {
    ...card(d, t), tagline: d.tagline || null, genres: (d.genres || []).map((g) => g.name), runtimeMin: d.runtime || d.episode_run_time?.[0] || null,
    status: d.status, seasons: d.number_of_seasons || null, episodes: d.number_of_episodes || null,
    cast: (d.credits?.cast || []).slice(0, 10).map((c) => ({ name: c.name, character: c.character, photo: c.profile_path ? IMG + 'w185' + c.profile_path : null })),
    directors: (d.credits?.crew || []).filter((c) => c.job === 'Director').map((c) => c.name),
    trailer: trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : null, homepage: d.homepage || null
  };
}

export async function trending(p, env) {
  const t = type(p);
  const d = await tmdb(env, `/trending/${t}/${p.window === 'day' ? 'day' : 'week'}`, { language: p.lang || 'en-US' });
  return { results: (d.results || []).slice(0, 20).map((x) => card(x, t)) };
}
