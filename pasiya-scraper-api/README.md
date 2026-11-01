# PASIYA Scraper API

Separate Node.js + Express service for PASIYA API. All `/v1/*` routes require `x-api-key` and JSON POST bodies.

## YouTube / Facebook / TikTok / Instagram

| Platform | Endpoint | Body |
|---|---|---|
| YouTube | `/v1/youtube/search` | `{ "query": "topic", "limit": 5 }` |
| YouTube | `/v1/youtube/details` | `{ "url": "https://www.youtube.com/watch?v=..." }` |
| YouTube | `/v1/youtube/download` | `{ "url": "https://your-authorized-media-host/file.mp4", "rightsConfirmed": true }` |
| Facebook | `/v1/facebook/search` | `{ "query": "topic" }` |
| Facebook | `/v1/facebook/details` | `{ "url": "https://www.facebook.com/..." }` |
| Facebook | `/v1/facebook/download` | `{ "url": "https://your-authorized-media-host/file.mp4", "rightsConfirmed": true }` |
| TikTok | `/v1/tiktok/search` | `{ "query": "topic" }` |
| TikTok | `/v1/tiktok/details` | `{ "url": "https://www.tiktok.com/@.../video/..." }` |
| TikTok | `/v1/tiktok/download` | `{ "url": "https://your-authorized-media-host/file.mp4", "rightsConfirmed": true }` |
| Instagram | `/v1/instagram/search` | `{ "query": "topic" }` |
| Instagram | `/v1/instagram/details` | `{ "url": "https://www.instagram.com/p/.../" }` |
| Instagram | `/v1/instagram/download` | `{ "url": "https://your-authorized-media-host/file.mp4", "rightsConfirmed": true }` |

YouTube search and public-page metadata extraction use yt-dlp. Facebook, TikTok and Instagram details work only for public pages that the upstream extractor can access. Their search routes return official platform search links because unrestricted automated search requires approved platform API access.

**Download limitation:** social-platform page URLs are not converted into media files. Download routes only return direct file URLs on domains explicitly listed in `AUTHORIZED_MEDIA_HOSTS`, and the caller must confirm ownership or permission with `rightsConfirmed: true`. Do not use these routes to bypass login, private-account settings, DRM, or platform restrictions.

## Existing services

- `POST /v1/mediafire/resolve` — `{ "url": "https://www.mediafire.com/..." }`
- `POST /v1/cinesubz/search` — `{ "query": "movie name" }`
- `POST /v1/cinesubz/details` — `{ "url": "..." }`
- `POST /v1/cinesubz/links` — `{ "url": "..." }`
- `POST /v1/sinhalasub/search` — `{ "query": "movie name" }`
- `POST /v1/sinhalasub/details` — `{ "url": "..." }`
- `POST /v1/sinhalasub/direct` — `{ "url": "..." }`
- `GET /health` — public deployment health check

## Deploy

1. Deploy this folder as a Node.js service.
2. Set `API_KEY` to a random secret of at least 24 characters.
3. Set `MAX_CONCURRENT_JOBS=1` for small hosts or `2` for a 2 GB host.
4. Set `AUTHORIZED_MEDIA_HOSTS` only to domains hosting media you own or are authorized to distribute.
5. Set the HTTPS service URL and same API key as Cloudflare Worker secrets `SCRAPER_URL` and `SCRAPER_SHARED_SECRET`.

## Security

API key authentication, timing-safe comparison, bounded JSON body size, concurrency limits, and public URL checks are enabled. Never expose the scraper secret in browser-side code or a public repository.
