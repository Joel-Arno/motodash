// „Ziel“-Fenster: Ziel suchen, Zwischenziele, Favoriten, Routen-Optionen.

import { reversePlace, searchPlaces } from './search.js?v=1.2.1';

const FAVORITES_KEY = 'motodash.favorites';
const SEARCH_DELAY_MS = 300;
const MIN_QUERY_LENGTH = 3;

const $ = (id) => document.getElementById(id);

const ICONS = {
  origin: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
  flag: '<svg class="i" viewBox="0 0 24 24"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>',
  up: '<svg class="i" viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg>',
  down: '<svg class="i" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  remove: '<svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  star: '<svg class="i" viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg>',
};

const OPTIONS = [
  { key: 'avoidHighways', label: 'Autobahnen vermeiden' },
  { key: 'avoidTolls', label: 'Mautstraßen vermeiden' },
  { key: 'avoidFerries', label: 'Fähren vermeiden' },
];

/**
 * @param {object} deps
 * @param {() => ({lng:number, lat:number} | null)} deps.getOrigin aktuelle Position
 * @param {object} deps.routeOptions gespeicherte Routen-Optionen (wird verändert)
 * @param {(options: object) => void} deps.onOptionsChange
 * @param {(points: object[], options: object) => Promise<void>} deps.onCalculate
 */
export function createPlanner({ getOrigin, routeOptions, onOptionsChange, onCalculate }) {
  const stops = []; // in Fahrreihenfolge, das letzte ist das Ziel
  let favorites = loadFavorites();
  let insertAt = 0;
  let searchTimer = 0;
  let searchAbort = null;
  let favoriteDraft = null;

  $('planner-close').addEventListener('click', close);
  $('planner-back').addEventListener('click', showPlan);
  $('add-stop').addEventListener('click', () => {
    // Neue Ziele kommen vor das Endziel – so entstehen Zwischenziele.
    showSearch(Math.max(0, stops.length - 1));
  });
  $('calc-route').addEventListener('click', calculate);
  $('search-input').addEventListener('input', onSearchInput);
  $('search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(searchTimer);
      runSearch();
      e.target.blur();
    }
  });
  $('save-here').addEventListener('click', saveCurrentPosition);
  $('fav-cancel').addEventListener('click', closeFavoriteDialog);
  $('fav-save').addEventListener('click', saveFavoriteDraft);
  $('fav-name').addEventListener('input', () => ($('fav-save').disabled = !$('fav-name').value.trim()));
  document.querySelectorAll('[data-fav-name]').forEach((chip) => {
    chip.addEventListener('click', () => {
      $('fav-name').value = chip.dataset.favName;
      $('fav-save').disabled = false;
    });
  });

  renderOptions();

  function open() {
    $('planner').hidden = false;
    if (stops.length) showPlan();
    else showSearch(0);
  }

  function close() {
    $('planner').hidden = true;
    searchAbort?.abort();
    closeFavoriteDialog();
  }

  function clearStops() {
    stops.length = 0;
  }

  // ---------- Ansichten ----------

  function showPlan() {
    searchAbort?.abort();
    $('planner-title').textContent = 'Route planen';
    $('planner-back').hidden = true;
    $('search-view').hidden = true;
    $('plan-view').hidden = false;
    hidePlanError();
    renderStops();
  }

  function showSearch(index) {
    insertAt = index;
    $('planner-title').textContent = stops.length ? 'Zwischenziel suchen' : 'Ziel suchen';
    $('planner-back').hidden = stops.length === 0;
    $('plan-view').hidden = true;
    $('search-view').hidden = false;
    $('search-input').value = '';
    $('search-results').replaceChildren();
    setSearchStatus('');
    renderFavorites();
    $('search-input').focus();
  }

  // ---------- Stopps ----------

  function renderStops() {
    const list = $('stop-list');
    list.replaceChildren();

    const origin = getOrigin();
    list.append(
      stopRow({
        badgeHtml: ICONS.origin,
        badgeClass: 'is-origin',
        title: 'Mein Standort',
        subtitle: origin ? 'Aktuelle Position' : 'Warte auf GPS …',
      }),
    );

    stops.forEach((place, i) => {
      const isLast = i === stops.length - 1;
      const row = stopRow({
        badgeHtml: isLast ? ICONS.flag : String(i + 1),
        badgeClass: isLast ? 'is-destination' : '',
        title: place.title,
        subtitle: place.subtitle,
      });
      const controls = document.createElement('div');
      controls.className = 'row-controls';
      // Umsortieren gibt es erst ab zwei Zielen.
      if (stops.length > 1) {
        controls.append(
          iconButton(ICONS.up, 'Nach oben', i === 0, () => moveStop(i, -1)),
          iconButton(ICONS.down, 'Nach unten', isLast, () => moveStop(i, 1)),
        );
      }
      controls.append(iconButton(ICONS.remove, 'Entfernen', false, () => removeStop(i)));
      row.append(controls);
      list.append(row);
    });

    $('add-stop').textContent = stops.length ? '+ Zwischenziel hinzufügen' : '+ Ziel hinzufügen';
    $('plan-hint').hidden = stops.length < 2;
    $('calc-route').disabled = stops.length === 0;
  }

  function moveStop(index, delta) {
    const [place] = stops.splice(index, 1);
    stops.splice(index + delta, 0, place);
    renderStops();
  }

  function removeStop(index) {
    stops.splice(index, 1);
    renderStops();
  }

  function selectPlace(place) {
    stops.splice(insertAt, 0, { title: place.title, subtitle: place.subtitle, lng: place.lng, lat: place.lat });
    showPlan();
  }

  // ---------- Suche ----------

  function onSearchInput() {
    clearTimeout(searchTimer);
    const query = $('search-input').value.trim();
    if (query.length < MIN_QUERY_LENGTH) {
      searchAbort?.abort();
      $('search-results').replaceChildren();
      setSearchStatus('');
      $('favorites-block').hidden = false;
      return;
    }
    searchTimer = setTimeout(runSearch, SEARCH_DELAY_MS);
  }

  async function runSearch() {
    const query = $('search-input').value.trim();
    if (query.length < MIN_QUERY_LENGTH) return;

    searchAbort?.abort();
    searchAbort = new AbortController();
    $('favorites-block').hidden = true;
    setSearchStatus('Suche …');

    try {
      const places = await searchPlaces(query, getOrigin(), searchAbort.signal);
      renderResults(places);
      setSearchStatus(places.length ? '' : 'Nichts gefunden. Versuch es mit Ort und Straße.');
    } catch (err) {
      if (err.name !== 'AbortError') setSearchStatus(err.message);
    }
  }

  function renderResults(places) {
    $('search-results').replaceChildren(
      ...places.map((place) =>
        placeRow({
          title: place.title,
          subtitle: place.subtitle,
          onSelect: () => selectPlace(place),
          action: iconButton(ICONS.star, 'Als Favorit speichern', false, () => openFavoriteDialog(place)),
        }),
      ),
    );
  }

  function setSearchStatus(text) {
    $('search-status').textContent = text;
    $('search-status').hidden = !text;
  }

  // ---------- Favoriten ----------

  function renderFavorites() {
    $('favorites-block').hidden = false;
    $('favorites-empty').hidden = favorites.length > 0;
    $('favorite-list').replaceChildren(
      ...favorites.map((fav) =>
        placeRow({
          title: fav.name,
          subtitle: [fav.title, fav.subtitle].filter((part) => part && part !== fav.name).join(', '),
          starred: true,
          onSelect: () => selectPlace({ ...fav, title: fav.name, subtitle: fav.title }),
          action: confirmButton(() => {
            favorites = favorites.filter((f) => f.id !== fav.id);
            saveFavorites(favorites);
            renderFavorites();
          }),
        }),
      ),
    );
  }

  async function saveCurrentPosition() {
    const origin = getOrigin();
    if (!origin) {
      setSearchStatus('Noch kein GPS-Signal – bitte kurz warten.');
      return;
    }
    const button = $('save-here');
    button.disabled = true;
    try {
      openFavoriteDialog(await reversePlace(origin.lng, origin.lat));
    } catch (err) {
      // Ohne Adresse trotzdem speichern können.
      if (err.name !== 'AbortError') openFavoriteDialog({ title: 'Gespeicherter Ort', subtitle: '', ...origin });
    } finally {
      button.disabled = false;
    }
  }

  function openFavoriteDialog(place) {
    favoriteDraft = place;
    $('fav-place').textContent = [place.title, place.subtitle].filter(Boolean).join(', ');
    $('fav-name').value = '';
    $('fav-save').disabled = true;
    $('fav-dialog').hidden = false;
  }

  function closeFavoriteDialog() {
    favoriteDraft = null;
    $('fav-dialog').hidden = true;
  }

  function saveFavoriteDraft() {
    const name = $('fav-name').value.trim();
    if (!favoriteDraft || !name) return;
    favorites.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      title: favoriteDraft.title,
      subtitle: favoriteDraft.subtitle,
      lng: favoriteDraft.lng,
      lat: favoriteDraft.lat,
    });
    saveFavorites(favorites);
    closeFavoriteDialog();
    renderFavorites();
    setSearchStatus(`„${name}“ gespeichert.`);
  }

  // ---------- Optionen & Berechnen ----------

  function renderOptions() {
    const container = $('route-option-list');
    container.replaceChildren(
      ...OPTIONS.map(({ key, label }) => {
        const button = document.createElement('button');
        button.className = 'toggle-row';
        button.setAttribute('role', 'switch');
        button.setAttribute('aria-checked', String(Boolean(routeOptions[key])));
        button.innerHTML = '<span class="toggle-label"></span><span class="switch" aria-hidden="true"></span>';
        button.querySelector('.toggle-label').textContent = label;
        button.addEventListener('click', () => {
          routeOptions[key] = !routeOptions[key];
          button.setAttribute('aria-checked', String(routeOptions[key]));
          onOptionsChange(routeOptions);
        });
        return button;
      }),
    );
  }

  async function calculate() {
    const origin = getOrigin();
    if (!origin) {
      showPlanError('Noch kein GPS-Signal – bitte kurz warten.');
      return;
    }
    hidePlanError();
    const button = $('calc-route');
    button.disabled = true;
    button.textContent = 'Berechne Route …';
    try {
      await onCalculate([origin, ...stops], { ...routeOptions });
      close();
    } catch (err) {
      showPlanError(err.message);
    } finally {
      button.disabled = stops.length === 0;
      button.textContent = 'Route berechnen';
    }
  }

  function showPlanError(message) {
    $('plan-error').textContent = message;
    $('plan-error').hidden = false;
  }

  function hidePlanError() {
    $('plan-error').hidden = true;
  }

  return { open, close, clearStops };
}

// ---------- DOM-Bausteine ----------

function stopRow({ badgeHtml, badgeClass, title, subtitle }) {
  const row = document.createElement('li');
  row.className = 'stop-row';
  row.innerHTML = `<span class="stop-badge ${badgeClass}">${badgeHtml}</span><div class="row-text"><div class="row-title"></div><div class="row-sub"></div></div>`;
  row.querySelector('.row-title').textContent = title;
  row.querySelector('.row-sub').textContent = subtitle;
  return row;
}

function placeRow({ title, subtitle, starred = false, onSelect, action }) {
  const row = document.createElement('li');
  row.className = 'place-row';
  const main = document.createElement('button');
  main.className = 'place-main';
  main.innerHTML = `${starred ? `<span class="place-star">${ICONS.star}</span>` : ''}<div class="row-text"><div class="row-title"></div><div class="row-sub"></div></div>`;
  main.querySelector('.row-title').textContent = title;
  main.querySelector('.row-sub').textContent = subtitle;
  main.addEventListener('click', onSelect);
  row.append(main, action);
  return row;
}

function iconButton(iconHtml, label, disabled, onClick) {
  const button = document.createElement('button');
  button.className = 'icon-btn';
  button.innerHTML = iconHtml;
  button.setAttribute('aria-label', label);
  button.disabled = disabled;
  button.addEventListener('click', onClick);
  return button;
}

/** Löschen erst beim zweiten Tippen – gegen versehentliches Entfernen. */
function confirmButton(onConfirm) {
  const button = iconButton(ICONS.remove, 'Favorit löschen', false, () => {
    if (button.classList.contains('is-confirm')) {
      onConfirm();
      return;
    }
    button.classList.add('is-confirm');
    button.textContent = 'Löschen?';
    setTimeout(() => {
      button.classList.remove('is-confirm');
      button.innerHTML = ICONS.remove;
    }, 3000);
  });
  return button;
}

function loadFavorites() {
  try {
    const stored = JSON.parse(localStorage.getItem(FAVORITES_KEY));
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

function saveFavorites(favorites) {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
  } catch {
    // Speicher nicht verfügbar – Favoriten gelten dann nur bis zum Neuladen.
  }
}
