# PASIYA API — by Pasidu Eshan

One website only: `pasiya-api-web/public/index.html` (the old Design-Preview html was removed; its features are now in this page).

## Features
- Login: Gmail/email + password (with Register tab, name, forgot-password, verification mail) and Google.
- Admin Panel appears automatically after login for `eshandinujaya86@gmail.com` (set in `wrangler.toml` > `ADMIN_EMAIL`). Admin has **unlimited coins**.
  Email-password accounts must verify the email first (security: nobody can register the owner's address and become admin). Google login is always verified.
- Admin can: give / remove coins by user email, see the user list, set **daily claim coins** and **biggest spin prize**.
- Free users: Daily claim + Daily Lucky Spin (once per day each, resets at Sri Lanka midnight; decided on the server, double-click safe).
- New users start with 10 coins. Paid APIs cost 1–2 coins, only charged on success.

## Setup (Sinhala/English)
1. Firebase Console > project `pasiya-api`:
   - **Build > Firestore Database > Create database** (production mode; rules in `firebase/firestore.rules` deny direct access, the Worker uses a service account).
   - **Build > Authentication > Sign-in method**: enable **Email/Password** and **Google**.
   - **Authentication > Settings > Authorized domains**: add your site domain (`xxxx.workers.dev` or custom domain).
   - **Project settings > Service accounts > Generate new private key** -> keep the JSON.
2. Deploy:
```
cd pasiya-api-web && npm install
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON   # paste the whole JSON
npx wrangler deploy
```
   Optional secrets: `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `TMDB_API_KEY`, `SCRAPER_URL`, `SCRAPER_SHARED_SECRET`.
3. Open the site, Register/Login with the admin email (verify the mail, or use Google) -> Admin Panel shows up.

## Tests
`cd pasiya-api-web && node test/run.mjs` — offline checks (mocked upstream sites).

## Keyless / built-in (no extra server, no API keys)
- AI (gemini, gpt, deepseek, claude, llama): Cloudflare Workers AI fallback (`[ai]` in wrangler.toml). Add real provider keys only if you want those exact models.
- Movies: IMDb lookup inside the Worker when no `TMDB_API_KEY` (search + details, ids `tt...`). `trending` needs the free TMDB key.
- YouTube search/details, TikTok, Facebook, Instagram (public link preview), MediaFire resolve: built-in scrapers in `src/modules/builtin.js`. Metadata only; private/login-only posts return 404.
- Any upstream that is down: last good answer (up to 7 days) is served from cache.
- These scrape public pages, so a site redesign can break one; the optional `pasiya-scraper-api/` (yt-dlp) can take over by setting `SCRAPER_URL` + `SCRAPER_SHARED_SECRET`.
