const elements = {
  summary: document.getElementById('summary'),
  loading: document.getElementById('loading'),
  empty: document.getElementById('empty'),
  error: document.getElementById('error'),
  errorDetail: document.getElementById('errorDetail'),
  grid: document.getElementById('grid'),
  lightbox: document.getElementById('lightbox'),
  lightboxImage: document.getElementById('lightboxImage'),
  lightboxCaption: document.getElementById('lightboxCaption'),
  lightboxClose: document.getElementById('lightboxClose'),
  sizeButtons: Array.from(document.querySelectorAll('[data-size]')),
};

let photos = [];
let tileSize = 'medium';

function showState(state) {
  elements.loading.classList.toggle('is-hidden', state !== 'loading');
  elements.empty.classList.toggle('is-hidden', state !== 'empty');
  elements.error.classList.toggle('is-hidden', state !== 'error');
  elements.grid.classList.toggle('is-hidden', state !== 'grid');
}

function openLightbox(photo) {
  elements.lightboxImage.src = window.eternal.fs.urlFor(photo.id);
  elements.lightboxImage.alt = photo.caption || photo.name;
  elements.lightboxCaption.textContent = photo.caption
    ? `${photo.name} — ${photo.caption}`
    : photo.name;
  elements.lightbox.classList.remove('is-hidden');
  elements.lightboxClose.focus();
}

function closeLightbox() {
  elements.lightbox.classList.add('is-hidden');
  elements.lightboxImage.src = '';
  elements.lightboxCaption.textContent = '';
}

function renderGrid() {
  elements.grid.innerHTML = '';
  for (const photo of photos) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'tile';
    tile.title = photo.name;

    const image = document.createElement('img');
    image.src = window.eternal.fs.urlFor(photo.id);
    image.alt = photo.caption || photo.name;
    image.loading = 'lazy';
    image.addEventListener('error', () => {
      // A missing blob should degrade into a labelled placeholder tile,
      // never a broken-image symbol or a crash.
      tile.classList.add('is-broken');
      tile.textContent = photo.name;
    });

    const label = document.createElement('span');
    label.className = 'tile-label';
    label.textContent = photo.name;

    tile.addEventListener('click', () => openLightbox(photo));
    tile.appendChild(image);
    tile.appendChild(label);
    elements.grid.appendChild(tile);
  }
}

async function loadPhotos() {
  showState('loading');
  elements.summary.textContent = 'Loading your photos…';
  try {
    const result = await window.eternal.fs.list({ mimeType: 'image/*', limit: 200 });
    photos = Array.isArray(result.items) ? result.items : [];

    if (photos.length === 0) {
      showState('empty');
      elements.summary.textContent = 'No photos yet';
      window.eternal.window.setTitle('Photo Grid');
      return;
    }

    renderGrid();
    showState('grid');
    const count = `${photos.length} photo${photos.length === 1 ? '' : 's'}`;
    elements.summary.textContent = count;
    window.eternal.window.setTitle(`Photo Grid — ${count}`);
  } catch (error) {
    showState('error');
    elements.errorDetail.textContent = error && error.message
      ? String(error.message)
      : 'The fs bridge is unavailable.';
    elements.summary.textContent = 'Could not load photos';
  }
}

function applyTileSize(size) {
  tileSize = size;
  document.documentElement.dataset.tileSize = size;
  elements.sizeButtons.forEach((button) => {
    const isActive = button.dataset.size === size;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-pressed', String(isActive));
  });
  // The tile-size preference rides the platform storage bridge. It is
  // cosmetic: a failed save must never break the app.
  window.eternal.storage.set('photo-grid.tileSize', size).catch(() => {});
}

async function restoreTileSize() {
  try {
    const saved = await window.eternal.storage.get('photo-grid.tileSize');
    if (saved === 'small' || saved === 'medium' || saved === 'large') {
      applyTileSize(saved);
    }
  } catch {
    // Storage unavailable — the default 'medium' stays.
  }
}

elements.sizeButtons.forEach((button) => {
  button.addEventListener('click', () => {
    applyTileSize(button.dataset.size);
  });
});

elements.lightboxClose.addEventListener('click', closeLightbox);
elements.lightbox.addEventListener('click', (event) => {
  if (event.target === elements.lightbox) closeLightbox();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeLightbox();
});

applyTileSize(tileSize);
restoreTileSize();
loadPhotos();
