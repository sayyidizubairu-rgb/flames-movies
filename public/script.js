const movieGrid = document.getElementById('movieGrid');
const searchInput = document.getElementById('search');
let movies = [];

const uploadForm = document.getElementById('uploadForm');
const uploadFile = document.getElementById('uploadFile');
const uploadUrl = document.getElementById('uploadUrl');
const uploadTitle = document.getElementById('uploadTitle');
const uploadDescription = document.getElementById('uploadDescription');
const seriesTitle = document.getElementById('seriesTitle');
const episodeLabel = document.getElementById('episodeLabel');
const showOnHomepage = document.getElementById('showOnHomepage');
const showInPopular = document.getElementById('showInPopular');
const submitButton = document.getElementById('submitButton');
const cancelEditButton = document.getElementById('cancelEditButton');
const editStatus = document.getElementById('editStatus');
const adminStats = document.getElementById('adminStats');
const trafficStats = document.getElementById('trafficStats');
const seriesBatchForm = document.getElementById('seriesBatchForm');
const batchSeriesTitle = document.getElementById('batchSeriesTitle');
const batchDescription = document.getElementById('batchDescription');
const seasonBlocks = document.getElementById('seasonBlocks');
const addSeasonButton = document.getElementById('addSeasonButton');
const batchShowOnHomepage = document.getElementById('batchShowOnHomepage');
const batchShowInPopular = document.getElementById('batchShowInPopular');
const batchSubmitButton = document.getElementById('batchSubmitButton');
const cancelSeriesEditButton = document.getElementById('cancelSeriesEditButton');
let editingKey = '';
let editingSeriesTitle = '';
let searchTimer = null;
let seasonCount = 0;

async function loadMovies() {
  try {
    const q = encodeURIComponent(searchInput ? (searchInput.value || '') : '');
    const includeHidden = uploadForm ? '&include_hidden=1' : '';
    const response = await fetch(`/api/movies?q=${q}${includeHidden}`);
    const data = await response.json();
    movies = Array.isArray(data) ? data : [];
    renderMovies(movies);
    if (adminStats) loadAdminStats();
    if (trafficStats) loadTrafficStats();
  } catch (error) {
    movies = [];
    renderMovies(movies);
  }
}

async function loadAdminStats() {
  try {
    const response = await fetch('/api/admin/stats');
    const data = await response.json();
    if (!data.ok) return;
    adminStats.innerHTML = [
      ['Total entries', data.total_entries],
      ['Homepage', data.homepage_entries],
      ['Search-only', data.search_only_entries],
      ['Popular', data.popular_entries],
      ['Public cards', data.public_cards],
      ['Series groups', data.series_groups]
    ].map(([label, value]) => `
      <div class="stat-box">
        <strong>${value}</strong>
        <span>${label}</span>
      </div>
    `).join('');
  } catch (error) {
    adminStats.innerHTML = '';
  }
}

async function loadTrafficStats() {
  try {
    const response = await fetch('/api/admin/traffic');
    const data = await response.json();
    if (!data.ok) return;
    trafficStats.innerHTML = [
      ['Active now', data.active_30m],
      ['Sessions today', data.visits_today],
      ['Sessions 7 days', data.visits_7d],
      ['Total sessions', data.total_visits]
    ].map(([label, value]) => `
      <div class="stat-box">
        <strong>${value}</strong>
        <span>${label}</span>
      </div>
    `).join('');
  } catch (error) {
    trafficStats.innerHTML = '';
  }
}

function renderMovies(list) {
  movieGrid.innerHTML = list
    .map(
      (movie) => {
        const key = encodeURIComponent(movie.key || movie.url || movie.id || movie.title || '');
        const title = movie.title || 'Untitled';
        const description = movie.description || '';
        const seriesMeta = movie.series_title ? `Series: ${movie.series_title}${movie.episode_label ? ` - ${movie.episode_label}` : ''} - ` : '';
        const statusMeta = `${seriesMeta}${movie.search_only ? 'Search only' : 'Homepage'}${movie.popular ? ' - Popular' : ''}`;
        const url = movie.url ? escapeAttr(movie.url) : '';
        const downloadId = escapeAttr(movie.id || '');
        return `
    <article class="movie-card">
      <div>
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(description)}</p>
        <small>${escapeHtml(statusMeta)}</small>
      </div>
      <div class="movie-meta">
        <span>${escapeHtml(movie.size || '-')}</span>
        ${uploadForm ? `
        <button type="button" data-key="${key}" data-search-only="${movie.search_only ? '0' : '1'}">
          ${movie.search_only ? 'Show on homepage' : 'Make search-only'}
        </button>
        <button type="button" data-popular-key="${key}" data-popular="${movie.popular ? '0' : '1'}">
          ${movie.popular ? 'Remove from popular' : 'Add to popular'}
        </button>
        <button type="button" data-edit-key="${key}">
          Edit
        </button>
        <button type="button" data-refresh-key="${key}">
          Refresh TMDb
        </button>
        <button type="button" data-delete-key="${key}" data-delete-title="${encodeURIComponent(title)}">
          Delete movie
        </button>
        ` : ''}
        ${movie.url ? `
        <a class="download-btn" href="${url}" target="_blank" rel="noopener noreferrer">
          Open Link
        </a>
        ` : `
        <a class="download-btn" href="/download/${downloadId}" download>
          Download
        </a>
        `}
      </div>
    </article>`;
      }
    )
    .join('');

  if (uploadForm) {
    movieGrid.querySelectorAll('button[data-key]').forEach((button) => {
      button.addEventListener('click', async () => {
        const body = new URLSearchParams();
        body.set('key', decodeURIComponent(button.dataset.key));
        body.set('search_only', button.dataset.searchOnly);
        const res = await fetch('/api/admin/movies/visibility', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body
        });
        const data = await res.json();
        if (!data.ok) {
          alert(data.error || 'Visibility update failed');
          return;
        }
        loadMovies();
      });
    });
    movieGrid.querySelectorAll('button[data-popular-key]').forEach((button) => {
      button.addEventListener('click', async () => {
        const body = new URLSearchParams();
        body.set('key', decodeURIComponent(button.dataset.popularKey));
        body.set('popular', button.dataset.popular);
        const res = await fetch('/api/admin/movies/popular', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body
        });
        const data = await res.json();
        if (!data.ok) {
          alert(data.error || 'Popular update failed');
          return;
        }
        loadMovies();
      });
    });
    movieGrid.querySelectorAll('button[data-edit-key]').forEach((button) => {
      button.addEventListener('click', () => {
        const key = decodeURIComponent(button.dataset.editKey);
        const movie = movies.find((item) => (item.key || item.url || item.id || item.title) === key);
        if (!movie) {
          alert('Movie not found');
          return;
        }
        if (movie.series_title) {
          startSeriesEdit(movie.series_title);
          return;
        }
        startEdit(movie);
      });
    });
    movieGrid.querySelectorAll('button[data-refresh-key]').forEach((button) => {
      button.addEventListener('click', async () => {
        const body = new URLSearchParams();
        body.set('key', decodeURIComponent(button.dataset.refreshKey));
        const res = await fetch('/api/admin/movies/refresh-metadata', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body
        });
        const data = await res.json();
        if (!data.ok) {
          alert(data.error || 'Metadata refresh failed');
          return;
        }
        loadMovies();
      });
    });
    movieGrid.querySelectorAll('button[data-delete-key]').forEach((button) => {
      button.addEventListener('click', async () => {
        const title = decodeURIComponent(button.dataset.deleteTitle);
        const confirmed = window.confirm(`Delete "${title}" from the catalog? This cannot be undone.`);
        if (!confirmed) return;

        const body = new URLSearchParams();
        body.set('key', decodeURIComponent(button.dataset.deleteKey));
        const res = await fetch('/api/admin/movies/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body
        });
        const data = await res.json();
        if (!data.ok) {
          alert(data.error || 'Delete failed');
          return;
        }
        loadMovies();
      });
    });
  }
}

function startEdit(movie) {
  editingKey = movie.key || movie.url || movie.id || movie.title;
  uploadTitle.value = movie.title || '';
  uploadDescription.value = movie.description || '';
  uploadUrl.value = movie.url || '';
  if (seriesTitle) seriesTitle.value = movie.series_title || '';
  if (episodeLabel) episodeLabel.value = movie.episode_label || '';
  if (showOnHomepage) showOnHomepage.checked = !movie.search_only;
  if (showInPopular) showInPopular.checked = Boolean(movie.popular);
  if (uploadFile) uploadFile.value = '';
  if (submitButton) submitButton.textContent = 'Save changes';
  if (cancelEditButton) cancelEditButton.hidden = false;
  if (editStatus) {
    editStatus.textContent = `Editing: ${movie.title || 'Untitled'}`;
    editStatus.style.display = 'block';
  }
  uploadForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function stopEdit() {
  editingKey = '';
  uploadForm.reset();
  if (submitButton) submitButton.textContent = 'Upload';
  if (cancelEditButton) cancelEditButton.hidden = true;
  if (editStatus) {
    editStatus.textContent = '';
    editStatus.style.display = 'none';
  }
}

function startSeriesEdit(seriesName) {
  if (!seriesBatchForm || !seasonBlocks) return;
  if (editingKey) stopEdit();
  const seriesEpisodes = movies
    .filter((item) => item.series_title === seriesName)
    .sort(compareEpisodeLabels);
  if (!seriesEpisodes.length) {
    alert('Series episodes not found');
    return;
  }

  editingSeriesTitle = seriesName;
  const firstEpisode = seriesEpisodes[0];
  batchSeriesTitle.value = seriesName;
  batchDescription.value = firstEpisode.description || '';
  if (batchShowOnHomepage) batchShowOnHomepage.checked = seriesEpisodes.some((episode) => !episode.search_only);
  if (batchShowInPopular) batchShowInPopular.checked = seriesEpisodes.some((episode) => episode.popular);

  seasonBlocks.innerHTML = '';
  seasonCount = 0;
  const seasons = new Map();
  for (const episode of seriesEpisodes) {
    const seasonNumber = parseSeasonNumber(episode.episode_label || episode.title);
    if (!seasons.has(seasonNumber)) {
      seasons.set(seasonNumber, addSeasonBlock(seasonNumber, false));
    }
    addEpisodeRow(
      seasons.get(seasonNumber),
      episode.url || episode.download_url || '',
      episode.episode_label || '',
      episode.key || episode.url || episode.id || episode.title || '',
      getStoredEpisodeTitle(episode)
    );
  }

  if (batchSubmitButton) batchSubmitButton.textContent = 'Save series changes';
  if (cancelSeriesEditButton) cancelSeriesEditButton.hidden = false;
  if (editStatus) {
    editStatus.textContent = `Editing series: ${seriesName}`;
    editStatus.style.display = 'block';
  }
  seriesBatchForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function stopSeriesEdit() {
  editingSeriesTitle = '';
  if (!seriesBatchForm || !seasonBlocks) return;
  seriesBatchForm.reset();
  seasonBlocks.innerHTML = '';
  seasonCount = 0;
  addSeasonBlock();
  if (batchSubmitButton) batchSubmitButton.textContent = 'Upload series episodes';
  if (cancelSeriesEditButton) cancelSeriesEditButton.hidden = true;
  if (!editingKey && editStatus) {
    editStatus.textContent = '';
    editStatus.style.display = 'none';
  }
}

if (uploadForm) {
  if (cancelEditButton) {
    cancelEditButton.addEventListener('click', stopEdit);
  }

  uploadForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData();
    const file = uploadFile.files[0];
    const url = uploadUrl.value.trim();
    const title = uploadTitle.value.trim();
    const description = uploadDescription.value.trim();
    const series = seriesTitle ? seriesTitle.value.trim() : '';
    const episode = episodeLabel ? episodeLabel.value.trim() : '';

    if (editingKey) {
      if (file) {
        alert('File changes are not supported while editing. Clear the file field, or upload it as a new item.');
        return;
      }

      const body = new URLSearchParams();
      body.set('key', editingKey);
      body.set('title', title);
      body.set('description', description);
      body.set('url', url);
      body.set('series_title', series);
      body.set('episode_label', episode);
      body.set('search_only', showOnHomepage && !showOnHomepage.checked ? '1' : '0');
      body.set('popular', showInPopular && showInPopular.checked ? '1' : '0');

      const res = await fetch('/api/admin/movies/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      });
      const data = await res.json();
      if (!data.ok) {
        alert(data.error || 'Update failed');
        return;
      }
      stopEdit();
      loadMovies();
      alert('Movie updated');
      return;
    }

    if (file) form.append('file', file);
    if (url) form.append('url', url);
    if (title) form.append('title', title);
    if (description) form.append('description', description);
    if (series) form.append('series_title', series);
    if (episode) form.append('episode_label', episode);
    if (showOnHomepage && !showOnHomepage.checked) form.append('search_only', '1');
    if (showInPopular && showInPopular.checked) form.append('popular', '1');
    const res = await fetch('/upload', { method: 'POST', body: form });
    const data = await res.json();
    if (data.ok) {
      uploadForm.reset();
      loadMovies();
      alert('Upload added');
    } else {
      alert(data.error || 'Upload failed');
    }
  });
}

function getEpisodeLabel(seasonNumber, episodeNumber) {
  return `S${String(seasonNumber).padStart(2, '0')}E${String(episodeNumber).padStart(2, '0')}`;
}

function getSeasonNumber(seasonBlock) {
  return Number(seasonBlock.dataset.season || '1') || 1;
}

function addEpisodeRow(seasonBlock, url = '', label = '', key = '', title = '') {
  const rows = seasonBlock && seasonBlock.querySelector('.episode-rows');
  if (!rows) return;
  const seasonNumber = getSeasonNumber(seasonBlock);
  const episodeNumber = rows.children.length + 1;
  const episodeLabelValue = label || getEpisodeLabel(seasonNumber, episodeNumber);
  const row = document.createElement('div');
  row.className = 'episode-row';
  row.innerHTML = `
    <input class="episode-key-input" type="hidden" value="${escapeAttr(key)}">
    <label>Episode label<input class="episode-label-input" type="text" value="${escapeAttr(episodeLabelValue)}" placeholder="${escapeAttr(getEpisodeLabel(seasonNumber, episodeNumber))}"></label>
    <label>Episode title<input class="episode-title-input" type="text" value="${escapeAttr(title)}" placeholder="Optional episode title"></label>
    <label>Episode link<input class="episode-url-input" type="url" value="${escapeAttr(url)}" placeholder="https://example.com/episode-link"></label>
    <button class="remove-episode" type="button">Remove</button>
  `;
  row.querySelector('.remove-episode').addEventListener('click', () => {
    row.remove();
    if (!rows.children.length) addEpisodeRow(seasonBlock);
  });
  rows.appendChild(row);
}

function addSeasonBlock(seasonNumber = null, addDefaultRows = true) {
  if (!seasonBlocks) return;
  seasonNumber = seasonNumber || seasonCount + 1;
  seasonCount = Math.max(seasonCount, seasonNumber);
  const block = document.createElement('section');
  block.className = 'season-block';
  block.dataset.season = String(seasonNumber);
  block.innerHTML = `
    <div class="season-head">
      <h4>Season ${seasonNumber}</h4>
      <div class="season-actions">
        <button class="secondary-btn add-season-episode" type="button">Add episode slot</button>
        ${seasonNumber > 1 ? '<button class="remove-episode remove-season" type="button">Remove season</button>' : ''}
      </div>
    </div>
    <div class="episode-rows"></div>
  `;
  block.querySelector('.add-season-episode').addEventListener('click', () => addEpisodeRow(block));
  const removeSeason = block.querySelector('.remove-season');
  if (removeSeason) {
    removeSeason.addEventListener('click', () => {
      block.remove();
      if (!seasonBlocks.children.length) {
        seasonCount = 0;
        addSeasonBlock();
      }
    });
  }
  seasonBlocks.appendChild(block);
  if (addDefaultRows) {
    addEpisodeRow(block);
    addEpisodeRow(block);
    addEpisodeRow(block);
  }
  return block;
}

if (seriesBatchForm) {
  addSeasonBlock();

  if (addSeasonButton) {
    addSeasonButton.addEventListener('click', () => addSeasonBlock());
  }

  if (cancelSeriesEditButton) {
    cancelSeriesEditButton.addEventListener('click', stopSeriesEdit);
  }

  seriesBatchForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const episodes = Array.from(seasonBlocks.querySelectorAll('.episode-row'))
      .map((row) => ({
        key: row.querySelector('.episode-key-input').value.trim(),
        label: row.querySelector('.episode-label-input').value.trim(),
        title: row.querySelector('.episode-title-input').value.trim(),
        url: row.querySelector('.episode-url-input').value.trim()
      }))
      .filter((episode) => episode.label || episode.url);

    if (!batchSeriesTitle.value.trim()) {
      alert('Series name is required');
      return;
    }

    if (!episodes.length || episodes.some((episode) => !episode.label || !episode.url)) {
      alert('Every episode row must have both a label and a link.');
      return;
    }

    if (batchSubmitButton) batchSubmitButton.disabled = true;
    try {
      const response = await fetch(editingSeriesTitle ? '/api/admin/series/update' : '/api/admin/series/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          original_series_title: editingSeriesTitle,
          series_title: batchSeriesTitle.value.trim(),
          description: batchDescription.value.trim(),
          episodes,
          search_only: batchShowOnHomepage && !batchShowOnHomepage.checked ? '1' : '0',
          popular: batchShowInPopular && batchShowInPopular.checked ? '1' : '0'
        })
      });
      const data = await response.json();
      if (!data.ok) {
        alert(data.error || 'Series upload failed');
        return;
      }
      const wasEditing = Boolean(editingSeriesTitle);
      stopSeriesEdit();
      loadMovies();
      if (wasEditing) {
        const removedText = data.removed ? `, removed ${data.removed}` : '';
        alert(`Updated ${data.updated} episode${data.updated === 1 ? '' : 's'}${removedText}`);
      } else {
        alert(`Added ${data.added} episode${data.added === 1 ? '' : 's'}`);
      }
    } catch (error) {
      alert('Series upload failed');
    } finally {
      if (batchSubmitButton) batchSubmitButton.disabled = false;
    }
  });
}

if (searchInput) {
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadMovies, 250);
  });
}

loadMovies();

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function parseSeasonNumber(value) {
  const text = String(value || '');
  const sxe = text.match(/\bs(?:eason)?\s*0*(\d+)\s*(?:e|ep|episode)\s*0*(\d+)\b/i);
  if (sxe) return normalizeSeasonNumber(sxe[1]);
  const xFormat = text.match(/\b0*(\d+)\s*x\s*0*(\d+)\b/i);
  if (xFormat) return normalizeSeasonNumber(xFormat[1]);
  const season = text.match(/\bseason\s*0*(\d+)\b/i);
  return season ? normalizeSeasonNumber(season[1]) : 1;
}

function parseEpisodeNumber(value) {
  const text = String(value || '');
  const sxe = text.match(/\bs(?:eason)?\s*0*(\d+)\s*(?:e|ep|episode)\s*0*(\d+)\b/i);
  if (sxe) return Number(sxe[2]);
  const episode = text.match(/\b(?:episode|ep|e)\s*0*(\d+)\b/i);
  if (episode) return Number(episode[1]);
  const numbers = [...text.matchAll(/\b0*(\d+)\b/g)]
    .map((match) => Number(match[1]))
    .filter((number) => number < 1900 || number > 2099);
  return numbers.length ? numbers[numbers.length - 1] : Number.MAX_SAFE_INTEGER;
}

function normalizeSeasonNumber(value) {
  const season = Number(value);
  return Number.isFinite(season) && season > 0 ? season : 1;
}

function compareEpisodeLabels(a, b) {
  const aLabel = a.episode_label || a.title || '';
  const bLabel = b.episode_label || b.title || '';
  const aSeason = parseSeasonNumber(aLabel);
  const bSeason = parseSeasonNumber(bLabel);
  if (aSeason !== bSeason) return aSeason - bSeason;
  return parseEpisodeNumber(aLabel) - parseEpisodeNumber(bLabel);
}

function getStoredEpisodeTitle(episode) {
  if (episode.episode_title) return episode.episode_title;
  const title = String(episode.title || '').trim();
  const series = String(episode.series_title || '').trim();
  const label = String(episode.episode_label || '').trim();
  let cleaned = title;
  if (series && cleaned.toLowerCase().startsWith(series.toLowerCase())) {
    cleaned = cleaned.slice(series.length).trim();
  }
  if (label && cleaned.toLowerCase().startsWith(label.toLowerCase())) {
    cleaned = cleaned.slice(label.length).trim();
  }
  return cleaned === title ? '' : cleaned;
}
