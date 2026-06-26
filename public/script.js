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
const seriesBatchForm = document.getElementById('seriesBatchForm');
const batchSeriesTitle = document.getElementById('batchSeriesTitle');
const batchDescription = document.getElementById('batchDescription');
const seasonBlocks = document.getElementById('seasonBlocks');
const addSeasonButton = document.getElementById('addSeasonButton');
const batchShowOnHomepage = document.getElementById('batchShowOnHomepage');
const batchShowInPopular = document.getElementById('batchShowInPopular');
const batchSubmitButton = document.getElementById('batchSubmitButton');
let editingKey = '';
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

function addEpisodeRow(seasonBlock, url = '') {
  const rows = seasonBlock && seasonBlock.querySelector('.episode-rows');
  if (!rows) return;
  const seasonNumber = getSeasonNumber(seasonBlock);
  const episodeNumber = rows.children.length + 1;
  const row = document.createElement('div');
  row.className = 'episode-row';
  row.innerHTML = `
    <label>Episode label<input class="episode-label-input" type="text" value="${escapeAttr(getEpisodeLabel(seasonNumber, episodeNumber))}" placeholder="${escapeAttr(getEpisodeLabel(seasonNumber, episodeNumber))}"></label>
    <label>Episode link<input class="episode-url-input" type="url" value="${escapeAttr(url)}" placeholder="https://example.com/episode-link"></label>
    <button class="remove-episode" type="button">Remove</button>
  `;
  row.querySelector('.remove-episode').addEventListener('click', () => {
    row.remove();
    if (!rows.children.length) addEpisodeRow(seasonBlock);
  });
  rows.appendChild(row);
}

function addSeasonBlock() {
  if (!seasonBlocks) return;
  seasonCount += 1;
  const seasonNumber = seasonCount;
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
  addEpisodeRow(block);
  addEpisodeRow(block);
  addEpisodeRow(block);
}

if (seriesBatchForm) {
  addSeasonBlock();

  if (addSeasonButton) {
    addSeasonButton.addEventListener('click', () => addSeasonBlock());
  }

  seriesBatchForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const episodes = Array.from(seasonBlocks.querySelectorAll('.episode-row'))
      .map((row) => ({
        label: row.querySelector('.episode-label-input').value.trim(),
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
      const response = await fetch('/api/admin/series/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
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
      seriesBatchForm.reset();
      seasonBlocks.innerHTML = '';
      seasonCount = 0;
      addSeasonBlock();
      loadMovies();
      alert(`Added ${data.added} episode${data.added === 1 ? '' : 's'}`);
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
