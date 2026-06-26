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
let editingKey = '';
let searchTimer = null;

async function loadMovies() {
  const q = encodeURIComponent(searchInput ? (searchInput.value || '') : '');
  const includeHidden = uploadForm ? '&include_hidden=1' : '';
  const response = await fetch(`/api/movies?q=${q}${includeHidden}`);
  movies = await response.json();
  renderMovies(movies);
  if (adminStats) loadAdminStats();
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
      (movie) => `
    <article class="movie-card">
      <div>
        <h3>${movie.title}</h3>
        <p>${movie.description}</p>
        <small>${movie.series_title ? `Series: ${movie.series_title}${movie.episode_label ? ` • ${movie.episode_label}` : ''} • ` : ''}${movie.search_only ? 'Search only' : 'Homepage'}${movie.popular ? ' • Popular' : ''}</small>
      </div>
      <div class="movie-meta">
        <span>${movie.size}</span>
        ${uploadForm ? `
        <button type="button" data-key="${encodeURIComponent(movie.key || movie.url || movie.id || movie.title)}" data-search-only="${movie.search_only ? '0' : '1'}">
          ${movie.search_only ? 'Show on homepage' : 'Make search-only'}
        </button>
        <button type="button" data-popular-key="${encodeURIComponent(movie.key || movie.url || movie.id || movie.title)}" data-popular="${movie.popular ? '0' : '1'}">
          ${movie.popular ? 'Remove from popular' : 'Add to popular'}
        </button>
        <button type="button" data-edit-key="${encodeURIComponent(movie.key || movie.url || movie.id || movie.title)}">
          Edit
        </button>
        <button type="button" data-refresh-key="${encodeURIComponent(movie.key || movie.url || movie.id || movie.title)}">
          Refresh TMDb
        </button>
        <button type="button" data-delete-key="${encodeURIComponent(movie.key || movie.url || movie.id || movie.title)}" data-delete-title="${encodeURIComponent(movie.title || 'Untitled')}">
          Delete movie
        </button>
        ` : ''}
        ${movie.url ? `
        <a class="download-btn" href="${movie.url}" target="_blank" rel="noopener noreferrer">
          Open Link
        </a>
        ` : `
        <a class="download-btn" href="/download/${movie.id}" download>
          Download
        </a>
        `}
      </div>
    </article>`
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
      alert('Upload failed');
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
