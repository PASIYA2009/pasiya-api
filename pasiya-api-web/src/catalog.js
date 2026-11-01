// Single source of truth for the public API list. The dashboard builds its docs + "Test" forms from this.
const P = (name, example, desc, required = true) => ({ name, example, desc, required });
const url = (ex) => P('url', ex, 'Public page / video URL');

export const CATALOG = [
  // Weather — free
  { path: '/api/weather', category: 'Weather', name: 'Weather by city', cost: 0, desc: 'Current weather + forecast for any city', params: [P('city', 'Colombo', 'City name'), P('days', '3', 'Forecast days (1-7)', false), P('country', 'LK', 'Country code to narrow the match', false)] },
  { path: '/api/weather/sri-lanka', category: 'Weather', name: 'Sri Lanka weather', cost: 0, desc: 'Current weather in 12 major Sri Lankan cities', params: [] },
  // News — free
  { path: '/api/news', category: 'News', name: 'Sri Lanka news', cost: 0, desc: 'Latest headlines from Sri Lankan news feeds', params: [P('source', 'all', 'all, or comma list: google-en, google-si, adaderana, hirunews, newswire, economynext, colombogazette', false), P('q', '', 'Filter by keyword', false), P('limit', '10', 'Max 30', false)] },
  { path: '/api/news/sources', category: 'News', name: 'News sources', cost: 0, desc: 'List the available news sources', params: [] },
  // TV — free
  { path: '/api/tv/channels', category: 'TV', name: 'Sri Lanka TV channels', cost: 0, desc: 'Channel list with logos and public live-stream links', params: [P('q', 'derana', 'Search by channel name', false), P('limit', '50', 'Max 100', false)] },
  // AI
  { path: '/api/ai/gemini', category: 'AI', name: 'Gemini', cost: 1, desc: 'Google Gemini chat', params: [P('prompt', 'Explain Sri Lanka in 2 lines', 'Your message'), P('system', '', 'Optional instruction', false)] },
  { path: '/api/ai/gpt', category: 'AI', name: 'GPT', cost: 1, desc: 'Open GPT model chat (free tiers first)', params: [P('prompt', 'Write a haiku about rain', 'Your message'), P('system', '', 'Optional instruction', false)] },
  { path: '/api/ai/deepseek', category: 'AI', name: 'DeepSeek', cost: 1, desc: 'DeepSeek chat', params: [P('prompt', 'What is 17 * 23?', 'Your message'), P('system', '', 'Optional instruction', false)] },
  { path: '/api/ai/claude', category: 'AI', name: 'Claude', cost: 2, desc: 'Claude chat (real Claude with an OpenRouter key, otherwise a free Llama fallback)', params: [P('prompt', 'Give me 3 startup ideas', 'Your message'), P('system', '', 'Optional instruction', false)] },
  { path: '/api/ai/llama', category: 'AI', name: 'Llama', cost: 1, desc: 'Llama chat on Cloudflare Workers AI', params: [P('prompt', 'Tell me a joke', 'Your message')] },
  // Movies (TMDB)
  { path: '/api/movie/search', category: 'Movies', name: 'Movie / TV search', cost: 1, desc: 'Titles, posters, ratings (TMDB, or keyless IMDb)', params: [P('q', 'Inception', 'Title'), P('type', 'movie', 'movie or tv', false), P('year', '', 'Release year', false)] },
  { path: '/api/movie/details', category: 'Movies', name: 'Movie / TV details', cost: 1, desc: 'Cast, genres, runtime, trailer', params: [P('id', '27205', 'Id from search (TMDB number or IMDb tt...)'), P('type', 'movie', 'movie or tv', false)] },
  { path: '/api/movie/trending', category: 'Movies', name: 'Trending titles', cost: 1, desc: 'What is trending this week', params: [P('type', 'movie', 'movie or tv', false), P('window', 'week', 'day or week', false)] },
  // Social metadata (built-in scrapers run inside the Worker; the optional Node scraper can replace them)
  { path: '/api/scraper/youtube/search', category: 'Social', name: 'YouTube search', cost: 1, desc: 'Search public YouTube videos', params: [P('query', 'sinhala songs', 'Search text'), P('limit', '5', 'Max 10', false)] },
  { path: '/api/scraper/youtube/details', category: 'Social', name: 'YouTube details', cost: 1, desc: 'Public video metadata', params: [url('https://www.youtube.com/watch?v=dQw4w9WgXcQ')] },
  { path: '/api/scraper/facebook/details', category: 'Social', name: 'Facebook details', cost: 1, desc: 'Public post metadata', params: [url('https://www.facebook.com/watch/?v=123')] },
  { path: '/api/scraper/tiktok/details', category: 'Social', name: 'TikTok details', cost: 1, desc: 'Public video metadata', params: [url('https://www.tiktok.com/@user/video/123')] },
  { path: '/api/scraper/instagram/details', category: 'Social', name: 'Instagram details', cost: 1, desc: 'Public post metadata', params: [url('https://www.instagram.com/p/abc/')] },
  { path: '/api/scraper/mediafire/resolve', category: 'Social', name: 'MediaFire resolve', cost: 1, desc: 'File name and direct link of a MediaFire page', params: [url('https://www.mediafire.com/file/abc/file.zip')] }
];
// Legacy scraper routes kept working for existing bots (not listed in the docs UI).
export const LEGACY_SCRAPER = [
  'youtube/download', 'facebook/search', 'facebook/download', 'tiktok/search', 'tiktok/download', 'instagram/search', 'instagram/download',
  'cinesubz/search', 'cinesubz/details', 'cinesubz/links', 'sinhalasub/search', 'sinhalasub/details', 'sinhalasub/direct'
];
