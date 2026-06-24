# Movie Download Website

A simple movie downloading website with a sample Express backend.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the site:
   ```bash
   ADMIN_PASSWORD=choose-a-strong-password npm start
   ```
3. Open `http://localhost:3000` in your browser.

## Notes

- This site uses sample `.mp4` files placed in the `movies/` directory.
- `public/` contains the frontend UI.
- `server.js` serves the app and download endpoints.
- Real posters and richer metadata are fetched from TMDb when `TMDB_API_KEY` is set. Without a key, movies without a saved real poster show as poster unavailable instead of using generated or random images.
- When `TMDB_API_KEY` is set, the public catalog also fetches TMDb trailer videos when available. Clicking a poster or Download opens a movie detail page with the trailer and final download button.
- Public visitors can browse and download only. Upload/import tools are available at `/admin` after login.
- Health checks can use `/health`.

## Going Public

To make the site public, deploy this folder to a Node.js host such as Render,
Railway, Fly.io, Heroku-compatible hosts, or a VPS.

Required production environment variables:

```bash
ADMIN_PASSWORD=choose-a-strong-private-password
ADMIN_SESSION_SECRET=generate-a-long-random-secret
TMDB_API_KEY=your-tmdb-api-key
DATABASE_URL=postgresql://user:password@host:5432/database
NODE_ENV=production
```

Most hosts set `PORT` automatically. If yours does not, set it too.

Build/start settings:

```bash
npm install
npm start
```

After deploy:

1. Open your public URL and confirm the catalog loads.
2. Open `/admin` and log in with `ADMIN_PASSWORD`.
3. Upload or add a movie link from the admin page.
4. Check `/health`; it should return `{ "ok": true }` and `"database_configured": true` when `DATABASE_URL` is set.

Important storage note: external movie links and catalog changes are stored in
Postgres when `DATABASE_URL` is set. If no database is configured, the app falls
back to `movies.json`, which can reset on hosts with temporary filesystems after
redeploys or restarts. Local file uploads still go into `movies/`, so use
external links or object storage for public hosting.

On Render, create a Postgres database or use Supabase, copy its Postgres
connection string, then add it to your web service as the `DATABASE_URL`
environment variable. On first deploy with a database, the app seeds the
database from the current `movies.json`. After that, admin uploads, deletes, and
homepage/popular toggles persist in the database.

## Admin

Set an admin password before running the public site:

```bash
ADMIN_PASSWORD=choose-a-strong-password npm start
```

For production, also set a stable session secret so admin sessions remain valid
across restarts:

```bash
ADMIN_PASSWORD=choose-a-strong-password ADMIN_SESSION_SECRET=change-this-long-random-string npm start
```

Then open `http://localhost:3000/admin` to upload files, add external links, or
run admin-only import/sync actions.

Movies can be marked as search-only from the admin page. Search-only movies are
hidden from the default homepage catalog but still appear when visitors search
for a matching title, description, genre, quality, or tag.

Series episodes can share one public poster/card. When uploading each episode,
fill in the same `Series name` and set an `Episode label` such as `Episode 1` or
`S01E02`. Public visitors see one series card, and the detail page lists the
episode download links.

## Uploading your own movies

As the admin, you can upload movies you own or have license to distribute:

1. Start the server (see steps above).
2. Open `http://localhost:3000/admin`.
3. Use the form to upload a file or provide an external URL. External link metadata is persisted in Postgres when `DATABASE_URL` is set, otherwise it falls back to `movies.json`. Uploaded files are saved to `movies/`.

Downloads:
- The server serves local files through `/download/:filename`.

Important: Do not upload copyrighted movies you do not have the rights to distribute.

## MeetDownload links

MeetDownload can be used as an external file host by adding a MeetDownload URL in
the admin page at `http://localhost:3000/admin`. The app stores the link in the
configured catalog storage and shows it in the catalog like GoFile links.

You can also import one MeetDownload file page directly:

```bash
curl "http://localhost:3000/import-meetdownload?url=https%3A%2F%2Fmeetdownload.com%2F29dc79b168fb4d0688f97242a256667d%2Fin-the-grey-2026-30742-mkv"
```

The importer reads public page metadata such as title, year, file extension, and
size, then keeps the catalog download link pointed at the MeetDownload page.

For bulk import or periodic sync, provide a JSON manifest of MeetDownload links
you own or have permission to distribute:

```bash
MEETDOWNLOAD_MANIFEST_PATH=meetdownload.manifest.example.json npm start
```

or from a hosted JSON file:

```bash
MEETDOWNLOAD_MANIFEST_URL=https://example.com/meetdownload-manifest.json npm start
```

Then run a manual sync:

```bash
curl http://localhost:3000/sync-meetdownload
```

The server also polls the manifest automatically every 30 minutes. Override that
with `MEETDOWNLOAD_POLL_INTERVAL_MS`.

Manifest format:

```json
[
  {
    "url": "https://meetdownload.com/example/my-authorized-movie",
    "title": "My Authorized Movie",
    "description": "Optional description",
    "year": 2026,
    "genre": "Drama",
    "quality": "1080P",
    "size": "1.4 GB"
  }
]
```

This sync catalogs links only. It does not scrape MeetDownload or mirror/download
third-party hosted media.
