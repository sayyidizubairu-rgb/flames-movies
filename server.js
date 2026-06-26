const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const FormData = require('form-data');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const DATABASE_URL = process.env.DATABASE_URL || null;
const moviesDir = path.join(__dirname, 'movies');
const postersDir = path.join(__dirname, 'public', 'posters');
const tmdbKey = process.env.TMDB_API_KEY || null;
const tmdbPending = new Set();
const tmdbGenreMap = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime', 99: 'Documentary',
  18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music',
  9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi', 53: 'Thriller', 10752: 'War', 37: 'Western'
};

app.set('trust proxy', 1);

// Ensure required directories exist
for (const dir of [moviesDir, postersDir]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const moviesFile = path.join(__dirname, 'movies.json');
let movies = [];
let dbPool = null;
let dbSaveQueue = Promise.resolve();

function loadMoviesFromFile() {
  try {
    const raw = fs.readFileSync(moviesFile, 'utf8');
    movies = JSON.parse(raw);
  } catch (err) {
    movies = [];
  }
}

function saveMovies(options = {}) {
  if (dbPool) {
    return queueMoviesDbSave(options);
  }

  try {
    fs.writeFileSync(moviesFile, JSON.stringify(movies, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save movies.json', err);
    return Promise.reject(err);
  }
  return Promise.resolve();
}

async function initializeStorage() {
  if (!DATABASE_URL) {
    loadMoviesFromFile();
    return;
  }

  dbPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
  });

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS movies_catalog (
      key TEXT PRIMARY KEY,
      position INTEGER NOT NULL DEFAULT 0,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const result = await dbPool.query('SELECT data FROM movies_catalog ORDER BY position ASC, updated_at DESC');
  if (result.rows.length) {
    movies = result.rows.map((row) => row.data);
    console.log(`Loaded ${movies.length} movies from database`);
    return;
  }

  loadMoviesFromFile();
  if (movies.length) {
    await saveMoviesToDb(movies);
    console.log(`Seeded database with ${movies.length} movies from movies.json`);
  }
}

function queueMoviesDbSave(options = {}) {
  const snapshot = movies.map((movie) => ({ ...movie }));
  const deletedKeys = new Set(options.deletedKeys || []);
  const saveTask = dbSaveQueue
    .catch(() => {})
    .then(async () => {
      const savedMovies = await saveMoviesToDb(snapshot, deletedKeys);
      movies = mergeMovieLists(movies, savedMovies, deletedKeys);
    })
    .catch((err) => {
      console.error('Failed to save movies to database', err);
      throw err;
    });
  dbSaveQueue = saveTask.catch(() => {});
  return saveTask;
}

async function saveMoviesToDb(snapshot, deletedKeys = new Set()) {
  if (!dbPool) return snapshot;
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE movies_catalog IN EXCLUSIVE MODE');
    const existing = await client.query('SELECT data FROM movies_catalog ORDER BY position ASC, updated_at DESC');
    const merged = mergeMovieLists(snapshot, existing.rows.map((row) => row.data), deletedKeys);
    await client.query('DELETE FROM movies_catalog');
    for (let index = 0; index < merged.length; index++) {
      const movie = merged[index];
      await client.query(
        `INSERT INTO movies_catalog (key, position, data, updated_at)
         VALUES ($1, $2, $3::jsonb, NOW())`,
        [getMovieKey(movie), index, JSON.stringify(movie)]
      );
    }
    await client.query('COMMIT');
    return merged;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function mergeMovieLists(primary, secondary, deletedKeys = new Set()) {
  const merged = [];
  const seen = new Set();

  for (const list of [primary || [], secondary || []]) {
    for (const movie of list) {
      const key = getMovieKey(movie);
      if (!key || deletedKeys.has(key) || seen.has(key)) continue;
      seen.add(key);
      merged.push(movie);
    }
  }

  return merged;
}

async function addMovieToCatalog(movie) {
  movies.unshift(movie);
  try {
    await saveMovies();
  } catch (err) {
    const index = movies.indexOf(movie);
    if (index !== -1) movies.splice(index, 1);
    throw err;
  }
  return movie;
}

async function addMoviesToCatalog(movieList) {
  const added = movieList.filter(Boolean);
  movies.unshift(...added);
  try {
    await saveMovies();
  } catch (err) {
    for (const movie of added) {
      const index = movies.indexOf(movie);
      if (index !== -1) movies.splice(index, 1);
    }
    throw err;
  }
  return added;
}

function getCookie(req, name) {
  const cookieHeader = req.headers.cookie || '';
  const cookies = cookieHeader.split(';').map((part) => part.trim()).filter(Boolean);
  for (const cookie of cookies) {
    const index = cookie.indexOf('=');
    if (index === -1) continue;
    if (cookie.slice(0, index) === name) return decodeURIComponent(cookie.slice(index + 1));
  }
  return '';
}

function signAdminToken() {
  const issuedAt = Date.now().toString();
  const signature = crypto
    .createHmac('sha256', ADMIN_SESSION_SECRET)
    .update(issuedAt)
    .digest('hex');
  return `${issuedAt}.${signature}`;
}

function hasValidAdminSession(req) {
  const token = getCookie(req, 'flamez_admin');
  const [issuedAt, signature] = token.split('.');
  if (!issuedAt || !signature) return false;
  const age = Date.now() - Number(issuedAt);
  if (!Number.isFinite(age) || age < 0 || age > 24 * 60 * 60 * 1000) return false;
  const expected = crypto
    .createHmac('sha256', ADMIN_SESSION_SECRET)
    .update(issuedAt)
    .digest('hex');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function requireAdminPage(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(500).send(getAdminSetupHtml());
  if (hasValidAdminSession(req)) return next();
  return res.status(401).send(getAdminLoginHtml());
}

function requireAdminApi(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(500).json({ ok: false, error: 'ADMIN_PASSWORD not set' });
  if (hasValidAdminSession(req)) return next();
  return res.status(401).json({ ok: false, error: 'Admin login required' });
}

function getAdminSetupHtml() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin setup</title>${getAdminStyles()}</head>
<body><main class="admin-card"><h1>Admin setup required</h1><p>Set <code>ADMIN_PASSWORD</code> before using the admin upload page.</p><pre>ADMIN_PASSWORD=choose-a-password npm start</pre></main></body></html>`;
}

function getAdminLoginHtml(error = '') {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin Login</title>${getAdminStyles()}</head>
<body><main class="admin-card"><h1>Admin login</h1>${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}<form method="post" action="/admin/login"><label>Password<input type="password" name="password" autocomplete="current-password" autofocus required></label><button type="submit">Log in</button></form><a href="/">Back to catalog</a></main></body></html>`;
}

function getAdminStyles() {
  return `<style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#081018;color:#e6eef6;font-family:Inter,system-ui,Segoe UI,Arial;padding:20px}
    .admin-card{width:min(440px,100%);padding:24px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.04);border-radius:10px}
    h1{margin:0 0 16px;font-size:1.35rem} p{color:#cbd5e1;line-height:1.6} label{display:grid;gap:8px;color:#cbd5e1}
    input{width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid rgba(255,255,255,.12);background:#0f172a;color:#fff}
    button{margin-top:14px;padding:11px 16px;border:0;border-radius:8px;background:#ff4d2d;color:#111;font-weight:800;cursor:pointer}
    a{display:inline-block;margin-top:18px;color:#ffb8a8} code,pre{background:#020617;border-radius:6px;padding:2px 6px} pre{padding:12px;overflow:auto}
    .error{padding:10px;border-radius:8px;background:rgba(239,68,68,.14);color:#fecaca}
  </style>`;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
}

function getMoviePageHtml(movie) {
  if (!movie) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Movie not found</title>${getPublicPageStyles()}</head><body><main class="detail-wrap"><a class="back-link" href="/">Back to catalog</a><section class="detail-panel"><h1>Movie not found</h1><p class="muted">This movie could not be found in the catalog.</p></section></main></body></html>`;
  }

  const title = escapeHtml(movie.title || 'Untitled');
  const description = escapeHtml(movie.description || 'No description available.');
  const cast = Array.isArray(movie.cast) ? movie.cast.filter(Boolean).slice(0, 8) : [];
  const castHtml = cast.length
    ? `<div class="cast-list">${cast.map((name) => `<span>${escapeHtml(name)}</span>`).join('')}</div>`
    : '<p class="muted">Cast unavailable.</p>';
  const isSeries = Array.isArray(movie.episodes) && movie.episodes.length;
  const episodeCount = isSeries ? `${movie.episodes.length} episode${movie.episodes.length === 1 ? '' : 's'}` : '';
  const meta = [movie.year || 'Unknown', movie.genre || 'Unknown', movie.rating ? `Rating ${movie.rating}` : '', episodeCount || movie.size || ''].filter(Boolean).map(escapeHtml).join(' • ');
  const downloadUrl = escapeHtml(movie.download_url || movie.url || (movie.id ? `/download/${movie.id}` : '#'));
  const rawPreviewImage = movie.poster || '/social-preview.png';
  const previewImage = escapeHtml(rawPreviewImage.startsWith('/') ? `https://www.flamezmovies.com${rawPreviewImage}` : rawPreviewImage);
  const pageUrl = escapeHtml(`https://www.flamezmovies.com/movie?key=${encodeURIComponent(movie.key || getMovieKey(movie) || '')}`);
  const poster = movie.poster ? `style="background-image:url('${escapeHtml(movie.poster)}')"` : '';
  const trailer = movie.trailer_url ? `<iframe class="trailer-frame" src="${escapeHtml(movie.trailer_url)}" title="${title} trailer" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>` : '<div class="trailer-missing">Trailer unavailable for this movie.</div>';
  const episodesHtml = isSeries
    ? `<section class="info-section" id="episodes"><h2>Episodes</h2><div class="season-list">${groupEpisodesBySeason(movie.episodes).map((season) => `
        <section class="season-holder">
          <div class="season-title"><h3>${escapeHtml(season.title)}</h3><span>${season.episodes.length} episode${season.episodes.length === 1 ? '' : 's'}</span></div>
          <div class="episode-list">${season.episodes.map((episode, index) => {
            const episodeTitle = escapeHtml(episode.episode_label || episode.title || `Episode ${index + 1}`);
            const episodeMeta = [episode.size, episode.quality].filter(Boolean).map(escapeHtml).join(' • ');
            const episodeUrl = escapeHtml(episode.download_url || episode.url || (episode.id ? `/download/${episode.id}` : '#'));
            return `<a class="episode-link" href="${episodeUrl}" target="_blank" rel="noopener noreferrer"><span>${episodeTitle}</span><small>${episodeMeta}</small></a>`;
          }).join('')}</div>
        </section>
      `).join('')}</div></section>`
    : '';
  const primaryAction = isSeries
    ? '<a class="download-large" href="#episodes">View episodes</a>'
    : `<a class="download-large" href="${downloadUrl}" target="_blank" rel="noopener noreferrer">Download movie</a>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} - Flamez Movies</title>
  <meta name="description" content="${description}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${pageUrl}">
  <meta property="og:title" content="${title} - Flamez Movies">
  <meta property="og:description" content="${description}">
  <meta property="og:image" content="${previewImage}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${title} - Flamez Movies">
  <meta name="twitter:description" content="${description}">
  <meta name="twitter:image" content="${previewImage}">
  ${getPublicPageStyles()}
</head>
<body>
  <header class="page-header"><div class="nav-inner"><a class="brand" href="/"><img class="brand-icon" src="/logo.svg" alt="Flamez Movies logo"><div class="brand-title"><div>Flamez Movies</div><span>Movie downloads</span></div></a><a class="nav-link" href="/">Browse</a></div></header>
  <main class="detail-wrap">
    <a class="back-link" href="/">Back to catalog</a>
    <section class="detail-panel">
      <div class="detail-grid">
        <div class="detail-poster ${movie.poster ? '' : 'no-poster'}" ${poster}></div>
        <div class="detail-copy">
          <div class="hero-pill">${escapeHtml(movie.quality || 'HD')}</div>
          <h1>${title}</h1>
          <p class="detail-meta">${meta}</p>
          ${primaryAction}
        </div>
      </div>
      ${episodesHtml}
      <section class="info-section">
        <h2>About</h2>
        <p class="detail-desc">${description}</p>
      </section>
      <section class="info-section">
        <h2>Cast</h2>
        ${castHtml}
      </section>
      <section class="trailer-section">
        <h2>Trailer</h2>
        ${trailer}
      </section>
    </section>
  </main>
</body>
</html>`;
}

function groupEpisodesBySeason(episodes) {
  const groups = new Map();
  for (const episode of sortSeriesEpisodes(episodes)) {
    const sortKey = parseEpisodeSortKey(episode.episode_label || episode.title);
    const season = sortKey.season === Number.MAX_SAFE_INTEGER ? 1 : sortKey.season;
    if (!groups.has(season)) {
      groups.set(season, {
        title: `Season ${season}`,
        episodes: []
      });
    }
    groups.get(season).episodes.push(episode);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, group]) => group);
}

function getPublicPageStyles() {
  return `<style>
    :root{--bg:#090d14;--muted:#9ca3af;--text:#f8fafc;--accent:#ff4d2d;--accent-2:#ff8c42;--max-width:1240px}
    *{box-sizing:border-box} html,body{margin:0;min-height:100%;background:radial-gradient(circle at top,rgba(255,77,45,.12),transparent 24%),linear-gradient(180deg,#090d14 0%,#020406 100%);color:var(--text);font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    a{color:inherit}.page-header{padding:24px 28px;background:rgba(6,10,18,.8);border-bottom:1px solid rgba(255,255,255,.04)}.nav-inner{max-width:var(--max-width);margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:16px}
    .brand{display:flex;align-items:center;gap:14px;text-decoration:none}.brand-icon{width:46px;height:46px;border-radius:16px;object-fit:cover;box-shadow:0 10px 24px rgba(255,77,45,.22);flex:0 0 auto}.brand-title{display:grid;line-height:1.1;font-weight:800}.brand-title span{font-size:.82rem;color:var(--muted);letter-spacing:.08em;text-transform:uppercase}.nav-link,.back-link{color:#ffb8a8;text-decoration:none}
    .detail-wrap{max-width:var(--max-width);margin:0 auto;padding:28px}.back-link{display:inline-block;margin-bottom:20px}.detail-panel{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:18px;overflow:hidden}.detail-grid{display:grid;grid-template-columns:minmax(220px,360px) 1fr;gap:28px;padding:28px}.detail-poster{min-height:520px;border-radius:14px;background:#0f172a;background-size:cover;background-position:center}.detail-poster.no-poster{display:grid;place-items:center;color:var(--muted)}.detail-poster.no-poster:before{content:"Poster unavailable"}.detail-copy{display:flex;flex-direction:column;align-items:flex-start;justify-content:center}.hero-pill{display:inline-flex;padding:9px 14px;border-radius:999px;background:rgba(255,77,45,.12);color:#ffb8a8;font-size:.78rem;letter-spacing:.14em;text-transform:uppercase;font-weight:800}.detail-copy h1{font-size:clamp(2rem,4vw,4rem);line-height:1;margin:18px 0 12px}.detail-meta{color:var(--muted);line-height:1.6}.detail-desc{color:#d8dee8;line-height:1.8;max-width:820px;margin:0}.muted{color:var(--muted)}.download-large{display:inline-flex;margin-top:12px;align-items:center;justify-content:center;padding:14px 22px;border-radius:999px;background:linear-gradient(90deg,var(--accent),var(--accent-2));color:#111;text-decoration:none;font-weight:900}.info-section,.trailer-section{padding:0 28px 28px}.info-section h2,.trailer-section h2{margin:0 0 14px}.cast-list{display:flex;flex-wrap:wrap;gap:10px}.cast-list span{padding:9px 12px;border-radius:999px;background:rgba(255,255,255,.08);color:#e5e7eb;border:1px solid rgba(255,255,255,.08);font-weight:700}.season-list{display:grid;gap:16px}.season-holder{padding:14px;border:1px solid rgba(255,255,255,.08);border-radius:14px;background:rgba(255,255,255,.035)}.season-title{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.season-title h3{margin:0;font-size:1.05rem}.season-title span{color:var(--muted);font-size:.82rem;font-weight:800}.episode-list{display:grid;gap:10px}.episode-link{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:14px 16px;border-radius:10px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.08);color:#fff;text-decoration:none;font-weight:800}.episode-link small{color:var(--muted);font-weight:700}.trailer-frame{width:100%;aspect-ratio:16/9;border:0;border-radius:14px;background:#020617}.trailer-missing{min-height:260px;display:grid;place-items:center;color:var(--muted);background:#020617;border-radius:14px}
    @media(max-width:760px){.detail-grid{grid-template-columns:1fr}.detail-poster{min-height:420px}.detail-wrap{padding:18px}}
  </style>`;
}

function isLocalPosterPath(poster) {
  return typeof poster === 'string' && poster.startsWith('/posters/');
}

function isUnstablePoster(poster) {
  return Boolean(poster && (poster.includes('picsum.photos') || poster.startsWith('data:image') || isLocalPosterPath(poster)));
}

function needsTmdbMetadata(movie) {
  return !movie.poster || isUnstablePoster(movie.poster) || !movie.description || !movie.year || !movie.rating || (!movie.trailer_url && !movie.trailer_checked) || (!movie.cast && !movie.cast_checked);
}

function refreshTmdbMetadataOnStartup() {
  if (!tmdbKey) return;
  movies.filter(needsTmdbMetadata).forEach(ensureTmdbMetadata);
}

function parseYearFromTitle(title) {
  const match = (title || '').match(/(19|20)\d{2}/);
  return match ? Number(match[0]) : undefined;
}

function parseQuality(title) {
  const q = (title || '').toLowerCase();
  const qualities = ['8k', '4k', '2160p', '1080p', '720p', '480p', 'hd', 'sd'];
  for (const quality of qualities) {
    if (q.includes(quality)) return quality.toUpperCase();
  }
  return 'HD';
}

function inferGenre(title, description) {
  const text = ((title || '') + ' ' + (description || '')).toLowerCase();
  const mapping = [
    ['Action', ['superman', 'battle', 'war', 'hero', 'fight', 'mission', 'revenge', 'killer', 'soldier', 'agent']],
    ['Thriller', ['mystery', 'thriller', 'detective', 'crime', 'serial', 'hunt', 'pursuit']],
    ['Drama', ['drama', 'family', 'love', 'story', 'adult', 'life', 'relationship']],
    ['Comedy', ['comedy', 'funny', 'laugh', 'humor', 'satire']],
    ['Sci-Fi', ['space', 'future', 'sci-fi', 'robot', 'alien', 'cyber', 'star', 'orbit']],
    ['Horror', ['horror', 'ghost', 'nightmare', 'zombie', 'blood', 'monster', 'evil']],
    ['Romance', ['love', 'romance', 'affair', 'couple', 'wedding', 'heart']]
  ];
  for (const [genre, keywords] of mapping) {
    if (keywords.some((keyword) => text.includes(keyword))) {
      return genre;
    }
  }
  return 'Drama';
}

function stableDownloadCount(title) {
  const hash = crypto.createHash('md5').update(title || 'movie').digest('hex').slice(0, 8);
  const value = parseInt(hash, 16);
  return 1500 + (value % 98000);
}

function stableRating(title) {
  const hash = crypto.createHash('md5').update(title || 'movie').digest('hex').slice(0, 4);
  const value = parseInt(hash, 16);
  return Number(((value % 40) / 10 + 6).toFixed(1));
}

function shouldUseRemotePosterUrls() {
  return process.env.NODE_ENV === 'production' || Boolean(DATABASE_URL);
}

function ensureTmdbMetadata(movie) {
  if (!tmdbKey || !movie.title) return Promise.resolve();
  const key = movie.url || movie.id || movie.title;
  if (tmdbPending.has(key)) return Promise.resolve();
  tmdbPending.add(key);
  const metadataTitle = movie.series_title || movie.title;
  return fetchTmdbInfo(metadataTitle, movie.year, { preferType: movie.series_title ? 'tv' : 'movie' })
    .then((info) => {
      if (!info) return;
      let updated = false;
      const isPlaceholderPoster = isUnstablePoster(movie.poster);
      if ((isPlaceholderPoster || !movie.poster) && info.poster) { movie.poster = info.poster; updated = true; }
      if (!movie.description && info.description) { movie.description = info.description; updated = true; }
      if (!movie.year && info.year) { movie.year = info.year; updated = true; }
      if (!movie.rating && info.rating) { movie.rating = info.rating; updated = true; }
      if (!movie.genre && info.genre) { movie.genre = info.genre; updated = true; }
      if (info.trailer_url && !movie.trailer_url) { movie.trailer_url = info.trailer_url; updated = true; }
      if (!movie.trailer_checked) { movie.trailer_checked = true; updated = true; }
      if (info.cast && !movie.cast) { movie.cast = info.cast; updated = true; }
      if (!movie.cast_checked) { movie.cast_checked = true; updated = true; }
      if (updated) saveMovies();
    })
    .catch((e) => {
      console.error('ensureTmdbMetadata error', e && e.toString());
    })
    .finally(() => {
      tmdbPending.delete(key);
    });
}

function normalizeMovieData(movie) {
  const normalized = { ...movie };
  normalized.title = normalized.title || 'Untitled';
  if (normalized.series_title) normalized.series_title = String(normalized.series_title).trim();
  if (normalized.episode_label) normalized.episode_label = String(normalized.episode_label).trim();
  normalized.description = normalized.description || 'No description available.';
  normalized.year = normalized.year || parseYearFromTitle(normalized.title);
  normalized.quality = normalized.quality || parseQuality(normalized.title);
  normalized.genre = normalized.genre || inferGenre(normalized.title, normalized.description);
  normalized.rating = normalized.rating || stableRating(normalized.title);
  normalized.downloads = normalized.downloads || stableDownloadCount(normalized.title);
  normalized.size = normalized.size || '—';
  normalized.download_url = normalized.download_url || normalized.url || (normalized.id ? `/download/${normalized.id}` : null);
  normalized.key = getMovieKey(normalized);
  if (normalized.poster && isUnstablePoster(normalized.poster)) {
    delete normalized.poster;
  }
  if (normalized.poster) {
    normalized.poster = getPublicPosterUrl(normalized.poster);
  }
  return normalized;
}

function getPublicPosterUrl(poster) {
  if (!poster || typeof poster !== 'string') return poster;
  if (isTmdbImageUrl(poster)) {
    return `/poster?url=${encodeURIComponent(poster)}`;
  }
  return poster;
}

function isTmdbImageUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname === 'image.tmdb.org';
  } catch (e) {
    return false;
  }
}

function getSeriesKey(title) {
  return `series:${normalizeTitleForFilename(title || 'series')}`;
}

function groupMoviesForPublic(list) {
  const grouped = [];
  const seriesMap = new Map();
  const movieKeys = new Set();

  for (const movie of list) {
    if (!movie.series_title) {
      const key = getMovieKey(movie);
      if (movieKeys.has(key)) continue;
      movieKeys.add(key);
      grouped.push(movie);
      continue;
    }

    const key = getSeriesKey(movie.series_title);
    let series = seriesMap.get(key);
    if (!series) {
      series = {
        ...movie,
        key,
        title: movie.series_title,
        series_title: movie.series_title,
        is_series: true,
        episodes: [],
        search_only: true,
        popular: false
      };
      seriesMap.set(key, series);
      grouped.push(series);
    }

    series.episodes.push(movie);
    series.search_only = series.search_only && Boolean(movie.search_only);
    series.popular = series.popular || Boolean(movie.popular);
    if (!series.poster && movie.poster) series.poster = movie.poster;
    if ((!series.description || series.description === 'No description available.') && movie.description) series.description = movie.description;
    if (!series.year && movie.year) series.year = movie.year;
    if (!series.genre && movie.genre) series.genre = movie.genre;
    if (!series.rating && movie.rating) series.rating = movie.rating;
    if (!series.trailer_url && movie.trailer_url) series.trailer_url = movie.trailer_url;
    if (!series.cast && movie.cast) series.cast = movie.cast;
  }

  for (const item of grouped) {
    if (item.episodes) {
      item.episodes = sortSeriesEpisodes(item.episodes);
      item.download_url = item.episodes[0] && item.episodes[0].download_url;
      item.size = `${item.episodes.length} episode${item.episodes.length === 1 ? '' : 's'}`;
      item.tags = `${item.tags || ''} ${item.episodes.map((episode) => `${episode.title || ''} ${episode.episode_label || ''}`).join(' ')}`.trim();
    }
  }

  return grouped;
}

function sortSeriesEpisodes(episodes) {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return [...episodes].sort((a, b) => {
    const aKey = parseEpisodeSortKey(a.episode_label || a.title);
    const bKey = parseEpisodeSortKey(b.episode_label || b.title);
    if (aKey.season !== bKey.season) return aKey.season - bKey.season;
    if (aKey.episode !== bKey.episode) return aKey.episode - bKey.episode;
    return collator.compare(String(a.episode_label || a.title || ''), String(b.episode_label || b.title || ''));
  });
}

function parseEpisodeSortKey(value) {
  const text = String(value || '');
  const missing = { season: Number.MAX_SAFE_INTEGER, episode: Number.MAX_SAFE_INTEGER };

  const sxe = text.match(/\bs(?:eason)?\s*0*(\d+)\s*(?:e|ep|episode)\s*0*(\d+)\b/i);
  if (sxe) return { season: normalizeSeasonNumber(sxe[1]), episode: Number(sxe[2]) };

  const xFormat = text.match(/\b0*(\d+)\s*x\s*0*(\d+)\b/i);
  if (xFormat) return { season: normalizeSeasonNumber(xFormat[1]), episode: Number(xFormat[2]) };

  const season = text.match(/\bseason\s*0*(\d+)\b/i);
  const episode = text.match(/\b(?:episode|ep|e)\s*0*(\d+)\b/i);
  if (episode) return { season: season ? normalizeSeasonNumber(season[1]) : 1, episode: Number(episode[1]) };

  const numbers = [...text.matchAll(/\b0*(\d+)\b/g)]
    .map((match) => Number(match[1]))
    .filter((number) => number < 1900 || number > 2099);
  if (numbers.length) return { season: 0, episode: numbers[numbers.length - 1] };

  return missing;
}

function normalizeSeasonNumber(value) {
  const season = Number(value);
  return Number.isFinite(season) && season > 0 ? season : 1;
}

function isSearchOnlyValue(value) {
  return value === true || value === 'true' || value === '1' || value === 'on';
}

function applySeriesFields(movie, source = {}) {
  const seriesTitle = String(source.series_title || source.seriesTitle || '').trim();
  const episodeLabel = String(source.episode_label || source.episodeLabel || '').trim();
  if (seriesTitle) movie.series_title = seriesTitle;
  if (episodeLabel) movie.episode_label = episodeLabel;
  return movie;
}

async function applyTmdbMetadata(movie, options = {}) {
  const metadataTitle = movie.series_title || movie.title;
  const info = await fetchTmdbInfo(metadataTitle, movie.year, {
    preferType: movie.series_title ? 'tv' : 'movie'
  });
  if (!info) return null;

  if (info.poster && (options.overwritePoster || !movie.poster)) movie.poster = info.poster;
  if (info.description && (options.overwriteText || !movie.description)) movie.description = info.description;
  if (info.year && (options.overwriteText || !movie.year)) movie.year = info.year;
  if (info.rating && (options.overwriteText || !movie.rating)) movie.rating = info.rating;
  if (info.genre && (options.overwriteText || !movie.genre)) movie.genre = info.genre;
  if (info.trailer_url && (options.overwriteText || !movie.trailer_url)) movie.trailer_url = info.trailer_url;
  if (info.cast && (options.overwriteText || !movie.cast)) movie.cast = info.cast;
  movie.trailer_checked = true;
  movie.cast_checked = true;
  return movie;
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    tmdb_configured: Boolean(tmdbKey),
    admin_configured: Boolean(ADMIN_PASSWORD),
    database_configured: Boolean(dbPool)
  });
});

app.get('/upload.html', (req, res) => {
  res.redirect('/admin');
});

app.get('/admin', requireAdminPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'upload.html'));
});

app.post('/admin/login', (req, res) => {
  if (!ADMIN_PASSWORD) {
    return res.status(500).send('ADMIN_PASSWORD is not set on this server.');
  }
  if (req.body.password !== ADMIN_PASSWORD) {
    return res.status(401).send(getAdminLoginHtml('Invalid password.'));
  }
  res.cookie('flamez_admin', signAdminToken(), {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000
  });
  res.redirect('/admin');
});

app.post('/admin/logout', (req, res) => {
  res.clearCookie('flamez_admin');
  res.redirect('/admin');
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/poster', async (req, res) => {
  const posterUrl = req.query.url;
  if (!isTmdbImageUrl(posterUrl)) {
    return res.status(400).send('Invalid poster URL.');
  }

  try {
    const response = await axios.get(posterUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      validateStatus: null
    });
    if (!response || response.status >= 400) {
      return res.status(502).send('Poster unavailable.');
    }

    const contentType = response.headers['content-type'] || 'image/jpeg';
    if (!contentType.startsWith('image/')) {
      return res.status(502).send('Poster unavailable.');
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    res.send(Buffer.from(response.data));
  } catch (e) {
    console.error('poster proxy error', e && e.toString());
    res.status(502).send('Poster unavailable.');
  }
});

app.get('/api/movies', async (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  const includeHidden = req.query.include_hidden === '1' && hasValidAdminSession(req);
  if (tmdbKey) {
    const pending = movies.filter(needsTmdbMetadata).map(ensureTmdbMetadata);
    if (pending.length) await Promise.all(pending);
  }
  const normalized = movies.map(normalizeMovieData);
  const publicList = includeHidden ? normalized : groupMoviesForPublic(normalized);
  if (!q) return res.json(includeHidden ? publicList : publicList.filter((m) => !m.search_only));
  const results = publicList.filter((m) => {
    const episodeText = Array.isArray(m.episodes)
      ? m.episodes.map((episode) => `${episode.title || ''} ${episode.episode_label || ''}`).join(' ')
      : `${m.series_title || ''} ${m.episode_label || ''}`;
    const hay = ((m.title || '') + ' ' + (m.description || '') + ' ' + (m.tags || '') + ' ' + (m.genre || '') + ' ' + (m.quality || '') + ' ' + episodeText).toLowerCase();
    return hay.includes(q);
  });
  res.json(results);
});

app.get('/api/admin/stats', requireAdminApi, (req, res) => {
  const normalized = movies.map(normalizeMovieData);
  const publicGrouped = groupMoviesForPublic(normalized);
  res.json({
    ok: true,
    total_entries: normalized.length,
    homepage_entries: normalized.filter((movie) => !movie.search_only).length,
    search_only_entries: normalized.filter((movie) => movie.search_only).length,
    popular_entries: normalized.filter((movie) => movie.popular).length,
    public_cards: publicGrouped.filter((movie) => !movie.search_only).length,
    series_groups: publicGrouped.filter((movie) => movie.is_series).length
  });
});

app.get('/movie', async (req, res) => {
  const key = req.query.key || '';
  const normalized = movies.map(normalizeMovieData);
  const publicList = groupMoviesForPublic(normalized);
  const movie = publicList.find((item) => item.key === key || getMovieKey(item) === key);
  if (!movie) return res.status(404).send(getMoviePageHtml(null));

  if (!movie.is_series && tmdbKey && needsTmdbMetadata(movie)) {
    const sourceMovie = movies.find((item) => getMovieKey(item) === key);
    if (sourceMovie) {
      await ensureTmdbMetadata(sourceMovie);
      return res.send(getMoviePageHtml(normalizeMovieData(sourceMovie)));
    }
  }

  res.send(getMoviePageHtml(movie));
});

app.get('/download/:filename', (req, res) => {
  const requestedFile = path.basename(req.params.filename);
  const filePath = path.join(moviesDir, requestedFile);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Movie not found.');
  }

  res.download(filePath, requestedFile, (err) => {
    if (err) {
      console.error('Download error:', err);
      if (!res.headersSent) {
        res.status(500).send('Unable to download the movie.');
      }
    }
  });
});

// Streaming removed — downloads served via /download/:filename only

// Max upload size (bytes). Default: 5 GB. Can be set via env MAX_UPLOAD_BYTES.
const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_UPLOAD_BYTES || String(5 * 1024 * 1024 * 1024), 10);
const uploadStorage = multer.diskStorage({
  destination: moviesDir,
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/\s+/g, '_');
    cb(null, `${Date.now()}-${safe}`);
  }
});
const upload = multer({ storage: uploadStorage, limits: { fileSize: MAX_UPLOAD_BYTES } });

app.post('/upload', requireAdminApi, (req, res) => {
  // Use multer as a function to capture errors (like file size limit) and return helpful messages
  upload.single('file')(req, res, function (err) {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ ok: false, error: 'File too large. Max upload size is ' + (MAX_UPLOAD_BYTES / (1024*1024*1024)).toFixed(1) + ' GB.' });
      }
      console.error('Upload error:', err);
      return res.status(500).json({ ok: false, error: 'Upload failed.' });
    }

    if (req.file) {
      (async () => {
        const id = req.file.filename;
        const title = req.body.title || req.file.originalname;
        const description = req.body.description || '';
        const size = `${(req.file.size / 1024 / 1024).toFixed(2)} MB`;
        const searchOnly = isSearchOnlyValue(req.body.search_only);
        const popular = isSearchOnlyValue(req.body.popular);

        // If GOFILE_UPLOAD=1 or GOFILE_TOKEN is set, forward the file to gofile.io and store the external link
        if (process.env.GOFILE_UPLOAD === '1' || process.env.GOFILE_TOKEN) {
          try {
            // get available upload servers from gofile
            const srvRes = await fetch('https://api.gofile.io/servers');
            const srvJson = await srvRes.json();
            const servers = (srvJson && srvJson.data && srvJson.data.servers) ? srvJson.data.servers : [];
            const best = servers.length ? servers[0].name : 'store3';
            const uploadUrl = `https://${best}.gofile.io/uploadfile`;

            const form = new FormData();
            form.append('file', fs.createReadStream(req.file.path));
            if (process.env.GOFILE_TOKEN) form.append('token', process.env.GOFILE_TOKEN);

            const headers = form.getHeaders();
            const upRes = await axios.post(uploadUrl, form, { headers, maxBodyLength: Infinity, validateStatus: null });
            const upJson = upRes.data;
            if (upJson.status === 'ok' && upJson.data) {
              const externalUrl = upJson.data.downloadPage || upJson.data.link || null;
              const movie = applySeriesFields({ id: null, url: externalUrl, title, description, size, search_only: searchOnly, popular }, req.body);
              try { await applyTmdbMetadata(movie, { overwritePoster: true }); } catch (e) {}
              await addMovieToCatalog(movie);
              // remove local file copy
              try { fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }
              return res.json({ ok: true, movie, uploadedTo: 'gofile' });
            } else {
              console.error('gofile upload failed', upJson);
              const movie = applySeriesFields({ id, title, description, size, search_only: searchOnly, popular }, req.body);
              try { await applyTmdbMetadata(movie, { overwritePoster: true }); } catch (e) {}
              await addMovieToCatalog(movie);
              return res.json({ ok: true, movie, warning: 'gofile upload failed, stored locally' });
            }
          } catch (e) {
            console.error('gofile integration error', e);
            const movie = applySeriesFields({ id, title, description, size, search_only: searchOnly, popular }, req.body);
            try { await applyTmdbMetadata(movie, { overwritePoster: true }); } catch (e) {}
            await addMovieToCatalog(movie);
            return res.json({ ok: true, movie, warning: 'gofile integration error, stored locally' });
          }
        }

        // default: keep local file and save metadata
        const movie = applySeriesFields({ id, title, description, size, search_only: searchOnly, popular }, req.body);
        try { await applyTmdbMetadata(movie, { overwritePoster: true }); } catch (e) {}
        await addMovieToCatalog(movie);
        return res.json({ ok: true, movie });
      })().catch((e) => {
        console.error('upload processing error', e);
        if (!res.headersSent) res.status(500).json({ ok: false, error: 'Upload failed while saving the catalog.' });
      });
      return;
    }

    if (req.body.url) {
      (async () => {
        const movie = await buildExternalMovieFromUrl(req.body.url, {
          title: req.body.title,
          description: req.body.description,
          search_only: req.body.search_only,
          popular: req.body.popular,
          series_title: req.body.series_title,
          episode_label: req.body.episode_label
        });
        await addMovieToCatalog(movie);
        return res.json({ ok: true, movie });
      })().catch((e) => {
        console.error('link upload processing error', e);
        if (!res.headersSent) res.status(500).json({ ok: false, error: 'Link upload failed while saving the catalog.' });
      });
      return;
    }

    res.status(400).json({ ok: false, error: 'No file or URL provided' });
  });
});

app.post('/api/admin/series/batch', requireAdminApi, async (req, res) => {
  const seriesTitle = String(req.body.series_title || '').trim();
  const description = String(req.body.description || '').trim();
  const episodes = Array.isArray(req.body.episodes) ? req.body.episodes : [];

  if (!seriesTitle) return res.status(400).json({ ok: false, error: 'Series name is required' });

  const validEpisodes = episodes
    .map((episode) => ({
      label: String(episode && episode.label ? episode.label : '').trim(),
      url: String(episode && episode.url ? episode.url : '').trim(),
      title: String(episode && episode.title ? episode.title : '').trim()
    }))
    .filter((episode) => episode.label && episode.url);

  if (!validEpisodes.length) {
    return res.status(400).json({ ok: false, error: 'Add at least one episode label and link' });
  }

  const duplicateInRequest = validEpisodes.find((episode, index) => validEpisodes.some((item, itemIndex) => itemIndex !== index && item.url === episode.url));
  if (duplicateInRequest) {
    return res.status(409).json({ ok: false, error: `Duplicate episode link in this upload: ${duplicateInRequest.url}` });
  }

  const existing = validEpisodes.find((episode) => movies.some((movie) => movie.url === episode.url));
  if (existing) {
    return res.status(409).json({ ok: false, error: `This episode link already exists: ${existing.url}` });
  }

  try {
    const batch = [];
    for (const episode of validEpisodes) {
      const movie = await buildExternalMovieFromUrl(episode.url, {
        title: episode.title || `${seriesTitle} ${episode.label}`,
        description,
        search_only: req.body.search_only,
        popular: req.body.popular,
        series_title: seriesTitle,
        episode_label: episode.label
      });
      batch.push(movie);
    }

    await addMoviesToCatalog(batch);
    res.json({ ok: true, added: batch.length, movies: batch.map(normalizeMovieData) });
  } catch (e) {
    console.error('series batch upload error', e);
    res.status(500).json({ ok: false, error: 'Series batch upload failed while saving.' });
  }
});

app.post('/api/admin/movies/visibility', requireAdminApi, async (req, res) => {
  const key = req.body.key;
  if (!key) return res.status(400).json({ ok: false, error: 'Movie key required' });

  const movie = movies.find((item) => getMovieKey(item) === key);
  if (!movie) return res.status(404).json({ ok: false, error: 'Movie not found' });

  const previousSearchOnly = movie.search_only;
  movie.search_only = isSearchOnlyValue(req.body.search_only);
  try {
    await saveMovies();
    res.json({ ok: true, movie: normalizeMovieData(movie) });
  } catch (e) {
    movie.search_only = previousSearchOnly;
    console.error('visibility save error', e);
    res.status(500).json({ ok: false, error: 'Visibility update failed while saving.' });
  }
});

app.post('/api/admin/movies/popular', requireAdminApi, async (req, res) => {
  const key = req.body.key;
  if (!key) return res.status(400).json({ ok: false, error: 'Movie key required' });

  const movie = movies.find((item) => getMovieKey(item) === key);
  if (!movie) return res.status(404).json({ ok: false, error: 'Movie not found' });

  const previousPopular = movie.popular;
  movie.popular = isSearchOnlyValue(req.body.popular);
  try {
    await saveMovies();
    res.json({ ok: true, movie: normalizeMovieData(movie) });
  } catch (e) {
    movie.popular = previousPopular;
    console.error('popular save error', e);
    res.status(500).json({ ok: false, error: 'Popular update failed while saving.' });
  }
});

app.post('/api/admin/movies/update', requireAdminApi, async (req, res) => {
  const key = req.body.key;
  if (!key) return res.status(400).json({ ok: false, error: 'Movie key required' });

  const movie = movies.find((item) => getMovieKey(item) === key);
  if (!movie) return res.status(404).json({ ok: false, error: 'Movie not found' });

  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ ok: false, error: 'Title is required' });

  const nextUrl = String(req.body.url || '').trim();
  const nextSeriesTitle = String(req.body.series_title || '').trim();
  const nextEpisodeLabel = String(req.body.episode_label || '').trim();
  const candidate = { ...movie };

  candidate.title = title;
  candidate.description = String(req.body.description || '').trim();
  candidate.search_only = isSearchOnlyValue(req.body.search_only);
  candidate.popular = isSearchOnlyValue(req.body.popular);

  if (nextUrl) {
    candidate.url = nextUrl;
    candidate.id = candidate.id || null;
  } else if (candidate.id) {
    delete candidate.url;
  } else if (candidate.url) {
    return res.status(400).json({ ok: false, error: 'External link is required for this catalog item' });
  }

  if (nextSeriesTitle) candidate.series_title = nextSeriesTitle;
  else delete candidate.series_title;

  if (nextEpisodeLabel) candidate.episode_label = nextEpisodeLabel;
  else delete candidate.episode_label;

  const originalKey = getMovieKey(movie);
  const nextKey = getMovieKey(candidate);
  if (nextKey !== originalKey && movies.some((item) => item !== movie && getMovieKey(item) === nextKey)) {
    return res.status(409).json({ ok: false, error: 'Another movie already uses that title or link' });
  }

  const previousMovie = { ...movie };
  Object.assign(movie, candidate);
  try {
    await saveMovies();
    res.json({ ok: true, movie: normalizeMovieData(movie) });
  } catch (e) {
    Object.assign(movie, previousMovie);
    console.error('movie update save error', e);
    res.status(500).json({ ok: false, error: 'Movie update failed while saving.' });
  }
});

app.post('/api/admin/movies/refresh-metadata', requireAdminApi, async (req, res) => {
  if (!tmdbKey) return res.status(400).json({ ok: false, error: 'TMDB_API_KEY not set' });
  const key = req.body.key;
  if (!key) return res.status(400).json({ ok: false, error: 'Movie key required' });

  const movie = movies.find((item) => getMovieKey(item) === key);
  if (!movie) return res.status(404).json({ ok: false, error: 'Movie not found' });

  try {
    const updated = await applyTmdbMetadata(movie, { overwritePoster: true, overwriteText: true });
    if (!updated) return res.status(404).json({ ok: false, error: 'No TMDb match found' });
    await saveMovies();
    res.json({ ok: true, movie: normalizeMovieData(movie) });
  } catch (e) {
    console.error('refresh metadata error', e);
    res.status(500).json({ ok: false, error: 'Metadata refresh failed' });
  }
});

app.post('/api/admin/movies/delete', requireAdminApi, async (req, res) => {
  const key = req.body.key;
  if (!key) return res.status(400).json({ ok: false, error: 'Movie key required' });

  const index = movies.findIndex((item) => getMovieKey(item) === key);
  if (index === -1) return res.status(404).json({ ok: false, error: 'Movie not found' });

  const [deleted] = movies.splice(index, 1);
  try {
    await saveMovies({ deletedKeys: [key] });
    res.json({ ok: true, deleted: normalizeMovieData(deleted) });
  } catch (e) {
    movies.splice(index, 0, deleted);
    console.error('movie delete save error', e);
    res.status(500).json({ ok: false, error: 'Movie delete failed while saving.' });
  }
});

function getMovieKey(movie) {
  return movie.url || movie.id || movie.title;
}

// Manual sync endpoint to import files from your Gofile account into the catalog.
app.get('/sync-gofile', requireAdminApi, async (req, res) => {
  if (!process.env.GOFILE_TOKEN) return res.status(400).json({ ok: false, error: 'GOFILE_TOKEN not set' });
  try {
    const added = await syncGofileOnce();
    res.json({ ok: true, added });
  } catch (e) {
    console.error('sync-gofile error', e);
    res.status(500).json({ ok: false, error: 'sync failed' });
  }
});

// --- Gofile account sync --------------------------------------------------
// If GOFILE_TOKEN is provided, periodically poll the gofile account contents
// and add any new files to the catalog. This allows files
// uploaded directly via gofile (with your token) to appear on the site.
const GOFILE_TOKEN = process.env.GOFILE_TOKEN || null;
const GOFILE_POLL_INTERVAL_MS = parseInt(process.env.GOFILE_POLL_INTERVAL_MS || String(5 * 60 * 1000), 10);
const MEETDOWNLOAD_MANIFEST_URL = process.env.MEETDOWNLOAD_MANIFEST_URL || null;
const MEETDOWNLOAD_MANIFEST_PATH = process.env.MEETDOWNLOAD_MANIFEST_PATH
  ? path.resolve(__dirname, process.env.MEETDOWNLOAD_MANIFEST_PATH)
  : null;
const MEETDOWNLOAD_POLL_INTERVAL_MS = parseInt(process.env.MEETDOWNLOAD_POLL_INTERVAL_MS || String(30 * 60 * 1000), 10);

function startBackgroundSyncs() {
  if (GOFILE_TOKEN) {
    // Run immediately, then on interval.
    (async () => {
      try { const n = await syncGofileOnce(); console.log('gofile sync added', n); } catch (e) { console.error('initial gofile sync failed', e && e.toString()); }
      setInterval(async () => {
        try { const n = await syncGofileOnce(); if (n) console.log('gofile sync added', n); } catch (e) { console.error('gofile sync error', e && e.toString()); }
      }, GOFILE_POLL_INTERVAL_MS);
    })();
  }

  if (MEETDOWNLOAD_MANIFEST_URL || MEETDOWNLOAD_MANIFEST_PATH) {
    (async () => {
      try {
        const n = await syncMeetdownloadOnce();
        if (n) console.log('meetdownload sync added', n);
      } catch (e) {
        console.error('initial meetdownload sync failed', e && e.toString());
      }

      setInterval(async () => {
        try {
          const n = await syncMeetdownloadOnce();
          if (n) console.log('meetdownload sync added', n);
        } catch (e) {
          console.error('meetdownload sync error', e && e.toString());
        }
      }, MEETDOWNLOAD_POLL_INTERVAL_MS);
    })();
  }
}

async function syncGofileOnce() {
  if (!GOFILE_TOKEN) throw new Error('GOFILE_TOKEN not configured');
  try {
    const resp = await axios.get('https://api.gofile.io/contents', { headers: { Authorization: `Bearer ${GOFILE_TOKEN}` }, validateStatus: null });
    if (!resp || !resp.data || resp.data.status !== 'ok') {
      throw new Error('gofile contents API error: ' + JSON.stringify(resp && resp.data));
    }
    const payload = resp.data.data || {};
    // payload may contain 'contents' or may itself be an array/object. Collect file items.
    let items = [];
    if (Array.isArray(payload)) items = payload;
    else if (Array.isArray(payload.contents)) items = payload.contents;
    else if (Array.isArray(payload.servers)) items = payload.servers; // fallback (unlikely)

    // If payload is an object keyed by id, flatten
    if (!items.length) {
      // Try to find file objects recursively
      const gather = (obj) => {
        if (!obj) return [];
        if (Array.isArray(obj)) return obj.flatMap(gather);
        if (typeof obj === 'object') {
          if (obj.type === 'file' || obj.mimetype) return [obj];
          return Object.values(obj).flatMap(gather);
        }
        return [];
      };
      items = gather(payload);
    }

    let added = 0;
    for (const it of items) {
      if (!it || (it.type && it.type !== 'file' && it.type !== 'file')) continue;
      // derive a stable url for the file
      const url = it.downloadPage || (it.parentFolderCode ? `https://gofile.io/d/${it.parentFolderCode}` : null) || it.link || null;
      const title = it.name || it.title || 'Untitled';
      const size = it.size ? (typeof it.size === 'number' ? `${it.size} bytes` : String(it.size)) : '—';

      // skip if we already have this URL or name
      const exists = movies.find(m => (m.url && url && m.url === url) || (m.title && m.title === title));
      if (exists) continue;

      const movie = { id: null, url, title, description: it.description || '', size };
      // attempt to fetch poster from TMDb when API key provided
      try {
        const poster = await fetchPoster(title, it.year || undefined);
        if (poster) movie.poster = poster;
      } catch (e) {
        // ignore poster errors
      }
      movies.unshift(movie);
      added++;
    }

    if (added) await saveMovies();
    return added;
  } catch (e) {
    console.error('syncGofileOnce error', e && e.toString());
    throw e;
  }
}

// --- MeetDownload catalog sync -------------------------------------------
// No public MeetDownload API key is required here. Provide a JSON manifest of
// MeetDownload links you own or are licensed to distribute, and the app will
// catalog those links without downloading or mirroring the hosted media.
app.get('/sync-meetdownload', requireAdminApi, async (req, res) => {
  if (!MEETDOWNLOAD_MANIFEST_URL && !MEETDOWNLOAD_MANIFEST_PATH) {
    return res.status(400).json({
      ok: false,
      error: 'Set MEETDOWNLOAD_MANIFEST_URL or MEETDOWNLOAD_MANIFEST_PATH'
    });
  }

  try {
    const added = await syncMeetdownloadOnce();
    res.json({ ok: true, added });
  } catch (e) {
    console.error('sync-meetdownload error', e);
    res.status(500).json({ ok: false, error: 'sync failed' });
  }
});

app.get('/import-meetdownload', requireAdminApi, async (req, res) => {
  const url = req.query.url;
  if (!isMeetdownloadUrl(url)) {
    return res.status(400).json({ ok: false, error: 'Provide a valid https://meetdownload.com/... URL' });
  }

  try {
    const movie = await buildMeetdownloadMovie(url);
    const existing = movies.find((m) => m.url === movie.url);
    if (existing) {
      const previousMovie = { ...existing };
      Object.assign(existing, { ...movie, id: existing.id || movie.id });
      try {
        await saveMovies();
        return res.json({ ok: true, added: false, movie: existing });
      } catch (e) {
        Object.assign(existing, previousMovie);
        throw e;
      }
    }

    await addMovieToCatalog(movie);
    return res.json({ ok: true, added: true, movie });
  } catch (e) {
    console.error('import-meetdownload error', e);
    res.status(500).json({ ok: false, error: 'import failed' });
  }
});

async function syncMeetdownloadOnce() {
  const entries = await loadMeetdownloadManifest();
  let added = 0;

  for (const entry of entries) {
    const movie = await normalizeMeetdownloadEntry(entry);
    if (!movie) continue;

    const exists = movies.find((m) => {
      return (m.url && m.url === movie.url) || (m.title && m.title === movie.title && m.source === 'meetdownload');
    });
    if (exists) continue;

    try {
      await applyTmdbMetadata(movie, { overwritePoster: Boolean(movie.series_title) });
    } catch (e) {
      // Keep catalog sync working even if metadata lookup fails.
    }

    movies.unshift(movie);
    added++;
  }

  if (added) await saveMovies();
  return added;
}

async function loadMeetdownloadManifest() {
  let raw;
  if (MEETDOWNLOAD_MANIFEST_URL) {
    const resp = await axios.get(MEETDOWNLOAD_MANIFEST_URL, { timeout: 20000, validateStatus: null });
    if (!resp || resp.status >= 400) {
      throw new Error(`MeetDownload manifest request failed: ${resp && resp.status}`);
    }
    raw = resp.data;
  } else {
    raw = fs.readFileSync(MEETDOWNLOAD_MANIFEST_PATH, 'utf8');
  }

  const manifest = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (Array.isArray(manifest)) return manifest;
  if (manifest && Array.isArray(manifest.movies)) return manifest.movies;
  if (manifest && Array.isArray(manifest.items)) return manifest.items;
  throw new Error('MeetDownload manifest must be an array, or contain a movies/items array');
}

async function normalizeMeetdownloadEntry(entry) {
  if (!entry) return null;
  const url = typeof entry === 'string' ? entry : entry.url || entry.download_url || entry.link;
  if (!isMeetdownloadUrl(url)) return null;

  const movie = await buildMeetdownloadMovie(url);

  if (typeof entry === 'object') {
    if (entry.title) movie.title = entry.title;
    if (entry.description) movie.description = entry.description;
    if (entry.size) movie.size = entry.size;
    if (entry.year) movie.year = Number(entry.year);
    if (entry.quality) movie.quality = entry.quality;
    if (entry.genre) movie.genre = entry.genre;
    if (entry.poster) movie.poster = entry.poster;
    if (entry.rating) movie.rating = Number(entry.rating);
    if (entry.tags) movie.tags = entry.tags;
    if (isSearchOnlyValue(entry.search_only)) movie.search_only = true;
    if (isSearchOnlyValue(entry.popular)) movie.popular = true;
    applySeriesFields(movie, entry);
    if (movie.series_title) {
      try { await applyTmdbMetadata(movie, { overwritePoster: true, overwriteText: !entry.description }); } catch (e) {}
    }
  }

  return movie;
}

async function buildExternalMovieFromUrl(url, overrides = {}) {
  if (isMeetdownloadUrl(url)) {
    const movie = await buildMeetdownloadMovie(url);
    if (overrides.title) movie.title = overrides.title;
    if (overrides.description) movie.description = overrides.description;
    movie.search_only = isSearchOnlyValue(overrides.search_only);
    movie.popular = isSearchOnlyValue(overrides.popular);
    applySeriesFields(movie, overrides);
    if (movie.series_title) {
      try { await applyTmdbMetadata(movie, { overwritePoster: true, overwriteText: !overrides.description }); } catch (e) {}
    }
    return movie;
  }

  const movie = applySeriesFields({
    id: null,
    url,
    title: overrides.title || url,
    description: overrides.description || '',
    size: '—',
    search_only: isSearchOnlyValue(overrides.search_only),
    popular: isSearchOnlyValue(overrides.popular)
  }, overrides);
  try { await applyTmdbMetadata(movie, { overwritePoster: true }); } catch (e) {}
  return movie;
}

async function buildMeetdownloadMovie(url) {
  const pageInfo = await fetchMeetdownloadPageInfo(url);
  const title = pageInfo.title || titleFromMeetdownloadUrl(url) || url;
  const movie = {
    id: null,
    url,
    source: 'meetdownload',
    title,
    description: pageInfo.description || '',
    size: pageInfo.size || '—'
  };

  if (pageInfo.year) movie.year = pageInfo.year;
  if (pageInfo.extension) movie.quality = pageInfo.extension.toUpperCase();
  if (pageInfo.uploaded) movie.uploaded = pageInfo.uploaded;

  try {
    const info = await fetchTmdbInfo(movie.title, movie.year);
    if (info) {
      if (info.poster) movie.poster = info.poster;
      if (info.description && !movie.description) movie.description = info.description;
      if (info.year && !movie.year) movie.year = info.year;
      if (info.rating && !movie.rating) movie.rating = info.rating;
      if (info.genre && !movie.genre) movie.genre = info.genre;
      if (info.trailer_url) movie.trailer_url = info.trailer_url;
      if (info.cast) movie.cast = info.cast;
      movie.trailer_checked = true;
      movie.cast_checked = true;
    }
  } catch (e) {}

  return movie;
}

async function fetchMeetdownloadPageInfo(url) {
  try {
    const resp = await axios.get(url, {
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
      validateStatus: null
    });
    if (!resp || resp.status >= 400 || typeof resp.data !== 'string') return {};
    return parseMeetdownloadPage(resp.data);
  } catch (e) {
    console.error('fetchMeetdownloadPageInfo error', e && e.toString());
    return {};
  }
}

function parseMeetdownloadPage(html) {
  const titleText =
    firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i) ||
    firstMatch(html, /<title[^>]*>\s*Download\s+([\s\S]*?)<\/title>/i) ||
    firstMatch(html, /<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);
  const cleanedTitle = cleanHtmlText(titleText)
    .replace(/\.(mkv|mp4|avi|mov|wmv|flv|webm)$/i, '')
    .trim();
  const year = parseYearFromTitle(cleanedTitle);

  return {
    title: cleanedTitle.replace(/\s*\((19|20)\d{2}\)\s*$/i, '').trim() || cleanedTitle,
    description: cleanHtmlText(firstMatch(html, /<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i)),
    size: cleanHtmlText(firstMatch(html, /<span[^>]*class=["'][^"']*size-number[^"']*["'][^>]*>[\s\S]*?([0-9]+(?:\.[0-9]+)?\s*(?:KB|MB|GB|TB))[\s\S]*?<\/span>/i)) ||
      cleanHtmlText(firstMatch(html, /Download\s+Video\s*\(([0-9]+(?:\.[0-9]+)?\s*(?:KB|MB|GB|TB))\)/i)),
    uploaded: cleanHtmlText(firstMatch(html, /Uploaded:\s*<\/?[^>]*>\s*([0-9-]+)/i) || firstMatch(html, /Uploaded:\s*([0-9-]+)/i)),
    extension: cleanHtmlText(firstMatch(html, /Extension:\s*<\/?[^>]*>\s*([A-Z0-9]+)/i) || firstMatch(html, /Extension:\s*([A-Z0-9]+)/i)),
    year
  };
}

function firstMatch(text, regex) {
  const match = text && text.match(regex);
  return match ? match[1] : '';
}

function cleanHtmlText(value) {
  return (value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#039;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function isMeetdownloadUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && /(^|\.)meetdownload\.com$/i.test(parsed.hostname);
  } catch (e) {
    return false;
  }
}

function titleFromMeetdownloadUrl(url) {
  try {
    const parsed = new URL(url);
    const slug = parsed.pathname.split('/').filter(Boolean).pop() || '';
    return slug
      .replace(/\.[a-z0-9]{2,4}$/i, '')
      .replace(/-[a-f0-9]{8,}$/i, '')
      .replace(/-\d{3,}$/i, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (char) => char.toUpperCase());
  } catch (e) {
    return '';
  }
}

// --- TMDb poster lookup --------------------------------------------------
async function fetchTmdbInfo(title, year, options = {}) {
  if (!tmdbKey || !title) return null;
  const baseQuery = normalizeTitleForSearch(title);
  if (!baseQuery) return null;
  const queries = buildTmdbSearchQueries(baseQuery);

  const searches = options.preferType === 'tv' ? [
    { path: 'search/tv', type: 'tv' },
    { path: 'search/movie', type: 'movie' }
  ] : [
    { path: 'search/movie', type: 'movie' },
    { path: 'search/tv', type: 'tv' }
  ];

  const yearAttempts = year ? [year, null] : [null];
  for (const activeYear of yearAttempts) {
    for (const query of queries) {
      for (const search of searches) {
        try {
          const params = { api_key: tmdbKey, query, include_adult: false };
          if (search.type === 'movie' && activeYear) params.primary_release_year = activeYear;
          if (search.type === 'tv' && activeYear) params.first_air_date_year = activeYear;

          const res = await axios.get(`https://api.themoviedb.org/3/${search.path}`, { params });
          if (res && res.data && Array.isArray(res.data.results) && res.data.results.length) {
            const best = chooseBestTmdbResult(res.data.results, query, activeYear);
            if (best) {
              const posterPath = best.poster_path || best.backdrop_path;
              const posterUrl = posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : null;
              const poster = posterUrl ? await resolvePosterUrl(title, posterUrl) : null;
              const overview = best.overview || null;
              const releaseDate = best.release_date || best.first_air_date || null;
              const resultYear = releaseDate ? Number(releaseDate.slice(0, 4)) : undefined;
              const rating = best.vote_average ? Number(best.vote_average.toFixed(1)) : undefined;
              const genre = Array.isArray(best.genre_ids) ? getTmdbGenreName(best.genre_ids) : undefined;
              const trailerUrl = await fetchTmdbTrailer(best.id, search.type);
              const cast = await fetchTmdbCast(best.id, search.type);
              return {
                poster,
                description: overview,
                year: resultYear,
                rating,
                genre,
                trailer_url: trailerUrl,
                cast
              };
            }
          }
        } catch (e) {
          console.error('fetchTmdbInfo error', e && e.toString());
        }
      }
    }
  }

  return null;
}

async function fetchPoster(title, year, options = {}) {
  const info = await fetchTmdbInfo(title, year, options);
  return info ? info.poster : null;
}

async function fetchTmdbTrailer(tmdbId, type) {
  if (!tmdbKey || !tmdbId) return null;
  try {
    const pathType = type === 'tv' ? 'tv' : 'movie';
    const res = await axios.get(`https://api.themoviedb.org/3/${pathType}/${tmdbId}/videos`, {
      params: { api_key: tmdbKey }
    });
    const results = res && res.data && Array.isArray(res.data.results) ? res.data.results : [];
    const candidates = results.filter((video) => {
      return video.site === 'YouTube' && video.key && /trailer|teaser/i.test(video.type || video.name || '');
    });
    const best = candidates.find((video) => video.official && video.type === 'Trailer') ||
      candidates.find((video) => video.type === 'Trailer') ||
      candidates[0];
    return best ? `https://www.youtube.com/embed/${best.key}` : null;
  } catch (e) {
    console.error('fetchTmdbTrailer error', e && e.toString());
    return null;
  }
}

async function fetchTmdbCast(tmdbId, type) {
  if (!tmdbKey || !tmdbId) return null;
  try {
    const pathType = type === 'tv' ? 'tv' : 'movie';
    const res = await axios.get(`https://api.themoviedb.org/3/${pathType}/${tmdbId}/credits`, {
      params: { api_key: tmdbKey }
    });
    const cast = res && res.data && Array.isArray(res.data.cast) ? res.data.cast : [];
    const names = cast
      .filter((person) => person && person.name)
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .slice(0, 8)
      .map((person) => person.name);
    return names.length ? names : null;
  } catch (e) {
    console.error('fetchTmdbCast error', e && e.toString());
    return null;
  }
}

function chooseBestTmdbResult(results, query, year) {
  const cleanedQuery = normalizeComparableTitle(query);
  if (!cleanedQuery) return null;
  let best = null;
  let bestScore = -1;
  const queryTokens = new Set(cleanedQuery.split(' ').filter(Boolean));

  for (const item of results) {
    const titles = [item.title, item.name, item.original_title, item.original_name]
      .filter(Boolean)
      .map(normalizeComparableTitle);
    const normalizedTitle = titles[0] || '';
    if (!normalizedTitle || (!item.poster_path && !item.backdrop_path)) continue;

    const titleTokens = new Set(normalizedTitle.split(' ').filter(Boolean));
    const common = [...queryTokens].filter((token) => titleTokens.has(token)).length;
    const overlap = queryTokens.size ? common / queryTokens.size : 0;
    const releaseDate = item.release_date || item.first_air_date || '';
    const resultYear = releaseDate ? Number(releaseDate.slice(0, 4)) : undefined;
    const yearDistance = year && resultYear ? Math.abs(year - resultYear) : null;
    const hasExactTitle = titles.some((candidate) => candidate === cleanedQuery);
    const hasStrongTitle = hasExactTitle || overlap >= 0.8;
    const hasUsableYear = !year || !resultYear || yearDistance <= 1;
    if (!hasStrongTitle || !hasUsableYear) continue;

    const yearScore = yearDistance === null ? 0 : Math.max(0, 2 - yearDistance);
    const exactTitleBonus = hasExactTitle ? 4 : 0;
    const score = exactTitleBonus + overlap * 4 + yearScore + Math.min((item.popularity || 0) / 100, 1);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  return best;
}

function normalizeComparableTitle(title) {
  return (title || '')
    .toString()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\blegend of\b/g, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getTmdbGenreName(genreIds) {
  for (const id of genreIds) {
    if (tmdbGenreMap[id]) return tmdbGenreMap[id];
  }
  return undefined;
}

function normalizeTitleForSearch(title) {
  if (!title) return '';
  let text = title.toString();
  text = text.replace(/\.(mkv|mp4|avi|mov|wmv|flv|webm)$/i, '');
  text = text.replace(/[._]/g, ' ');
  text = text.replace(/\[(.*?)\]|\((.*?)\)/g, ' ');
  text = text.replace(/\blegend of\b/gi, ' ');
  text = text.replace(/\b(?:NaijaPrey|NaijaPrey\.com|Naija[-_ ]?Prey|www|com|net|org|info|club|movie|movies|download|downloaded|exclusive|official|1080p|720p)\b/gi, ' ');
  text = text.replace(/\b(S\d{1,2}E\d{1,2}|S\d{1,2}|E\d{1,2}|\d{3,4}p|HDTV|WEB[- ]DL|WEBRip|BluRay|BRRip|DVDRip|x264|x265|HEVC|H\.264|YIFY|RARBG|EVO|PROPER|LIMITED|EXTENDED|UNRATED|DUBBED|ESUB|LiNE|CAM)\b/gi, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

function buildTmdbSearchQueries(cleanTitle) {
  if (!cleanTitle) return [];
  const queries = new Set([cleanTitle]);
  const words = cleanTitle.split(' ').filter(Boolean);
  if (words.length > 2) {
    queries.add(words.slice(0, 3).join(' '));
    queries.add(words.slice(-3).join(' '));
  }
  if (words.length > 4) {
    queries.add(words.filter((word) => word.length > 3).slice(0, 4).join(' '));
  }
  return Array.from(queries).filter(Boolean);
}

function normalizeTitleForFilename(title) {
  if (!title) return 'poster';
  return title
    .toString()
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'poster';
}

async function resolvePosterUrl(title, posterUrl) {
  if (shouldUseRemotePosterUrls()) {
    return posterUrl;
  }
  return cachePosterImage(title, posterUrl);
}

async function cachePosterImage(title, posterUrl) {
  const hash = crypto.createHash('md5').update(posterUrl).digest('hex').slice(0, 12);
  const safeName = `${normalizeTitleForFilename(title)}-${hash}.jpg`;
  const filePath = path.join(postersDir, safeName);
  const publicPath = `/posters/${safeName}`;

  if (fs.existsSync(filePath)) {
    return publicPath;
  }

  try {
    const response = await axios.get(posterUrl, { responseType: 'arraybuffer', timeout: 15000 });
    if (response.status === 200) {
      fs.writeFileSync(filePath, response.data);
      return publicPath;
    }
  } catch (e) {
    console.error('cachePosterImage error', e && e.toString());
  }

  return posterUrl;
}

// Serve SPA for all other routes (catch-all)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function startServer() {
  try {
    await initializeStorage();
    refreshTmdbMetadataOnStartup();
    startBackgroundSyncs();
    app.listen(PORT, () => {
      console.log(`Movie download site running at http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server', err);
    process.exit(1);
  }
}

startServer();
