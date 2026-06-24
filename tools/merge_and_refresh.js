const fs = require('fs');
const path = require('path');

const moviesFile = path.join(__dirname, '..', 'movies.json');
const raw = fs.readFileSync(moviesFile, 'utf8');
let movies = [];
try { movies = JSON.parse(raw); } catch (e) { console.error('failed parse', e); process.exit(1); }

function normalizeKey(title) {
  if (!title) return '';
  let t = title.toString();
  t = t.replace(/\.(mkv|mp4|avi|mov|wmv|flv|webm)$/i, '');
  t = t.replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();
  return t;
}

const groups = new Map();
for (const m of movies) {
  const key = normalizeKey(m.title || m.url || m.id || '');
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(m);
}

const merged = [];
for (const [key, items] of groups.entries()) {
  if (!items.length) continue;
  // choose representative with most metadata
  const sorted = items.slice().sort((a,b) => {
    const score = (x) => (x.poster?4:0) + (x.description?2:0) + (x.year?1:0) + (x.url?1:0) + (x.id?1:0);
    return score(b) - score(a);
  });
  const rep = Object.assign({}, sorted[0]);

  // collect sources
  const sources = [];
  for (const it of items) {
    const s = {};
    if (it.id) s.id = it.id;
    if (it.url) s.url = it.url;
    // avoid duplicates
    if (!sources.find(x => x.id === s.id && x.url === s.url)) sources.push(s);
  }

  // normalize title (Title Case) from key
  const titleFromKey = key.split(' ').map(w => w ? (w[0].toUpperCase()+w.slice(1)) : '').join(' ').trim();
  rep.title = rep.title && rep.title.length >= titleFromKey.length ? rep.title : titleFromKey || (rep.title||'Untitled');

  // attach sources
  rep.sources = sources;
  // ensure url is a primary source (first source url if any)
  if ((!rep.url || rep.url===null) && sources.length && sources[0].url) rep.url = sources[0].url;

  // cleanup duplicates metadata
  // remove exact duplicates later
  merged.push(rep);
}

// sort merged: keep original order roughly
// write back
fs.writeFileSync(moviesFile, JSON.stringify(merged, null, 2), 'utf8');
console.log('Wrote merged movies.json with', merged.length, 'entries');
