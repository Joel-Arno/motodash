// „Ziel“-Fenster: Ziel suchen, Zwischenziele, Favoriten, Rundtouren, Routen-Optionen.

import { reversePlace, searchPlaces } from './search.js?v=1.2.1';
import { PLACE_CATEGORIES, findPlaces } from './places.js?v=2.0';

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

// Rundtour-Länge: Schnellwahl und Schieberegler, je nach Einheit.
const TOUR_UNITS = {
  km: { key: 'km', presets: [50, 100, 150, 200], min: 20, max: 400, step: 10 },
  time: { key: 'hours', presets: [1, 2, 3, 4], min: 0.5, max: 6, step: 0.25 },
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
 * @param {{mode:'dest'|'tour', unit:'km'|'time', km:number, hours:number, direction:number|null}} deps.plan
 *   gespeicherte Planer-Einstellungen (wird verändert)
 * @param {() => void} deps.onPlanChange
 * @param {(spec: object, options: object, onProgress: Function) => Promise<void>} deps.onTourCalculate
 */
export function createPlanner({
  getOrigin,
  routeOptions,
  onOptionsChange,
  onCalculate,
  plan,
  onPlanChange,
  onTourCalculate,
  getRouteContext, // laufende/gewählte Route, um entlang davon zu suchen
  onQuickStop, // Zwischenstopp in eine laufende Route einfügen
}) {
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

  document.querySelectorAll('[data-plan-mode]').forEach((tab) => {
    tab.addEventListener('click', () => {
      plan.mode = tab.dataset.planMode;
      onPlanChange();
      if (plan.mode === 'tour') showTour();
      else if (stops.length) showPlan();
      else showSearch(0);
    });
  });
  document.querySelectorAll('[data-tour-unit]').forEach((button) => {
    button.addEventListener('click', () => {
      plan.unit = button.dataset.tourUnit;
      onPlanChange();
      renderTour();
    });
  });
  document.querySelectorAll('[data-direction]').forEach((button) => {
    button.addEventListener('click', () => {
      plan.direction = button.dataset.direction === '' ? null : Number(button.dataset.direction);
      onPlanChange();
      renderTour();
    });
  });
  $('tour-slider').addEventListener('input', (e) => {
    plan[TOUR_UNITS[plan.unit].key] = Number(e.target.value);
    renderTourValue();
  });
  $('tour-slider').addEventListener('change', onPlanChange);
  $('calc-tour').addEventListener('click', calculateTour);

  function open() {
    $('planner').hidden = false;
    renderCategories();
    if (plan.mode === 'tour') showTour();
    else if (stops.length) showPlan();
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

  /** @param {'plan'|'search'|'tour'} name */
  function setView(name) {
    $('plan-view').hidden = name !== 'plan';
    $('search-view').hidden = name !== 'search';
    $('tour-view').hidden = name !== 'tour';
    // Umschalter Ziel/Rundtour – nicht beim Suchen eines Zwischenziels.
    $('plan-tabs').hidden = name === 'search' && stops.length > 0;
    // Tankstelle & Co. gehören zur Zielplanung, nicht zur Rundtour-Einstellung.
    $('place-categories').hidden = name === 'tour';
    document.querySelectorAll('[data-plan-mode]').forEach((tab) => {
      tab.setAttribute('aria-selected', String((tab.dataset.planMode === 'tour') === (name === 'tour')));
    });
  }

  function showPlan() {
    searchAbort?.abort();
    $('planner-title').textContent = 'Route planen';
    $('planner-back').hidden = true;
    setView('plan');
    hidePlanError();
    renderStops();
    renderOptions('route-option-list');
  }

  function showTour() {
    searchAbort?.abort();
    $('planner-title').textContent = 'Rundtour planen';
    $('planner-back').hidden = true;
    setView('tour');
    $('tour-error').hidden = true;
    renderTour();
    renderOptions('tour-option-list');
  }

  function showSearch(index) {
    insertAt = index;
    $('planner-title').textContent = stops.length ? 'Zwischenziel suchen' : 'Ziel suchen';
    $('planner-back').hidden = stops.length === 0;
    setView('search');
    $('search-input').value = '';
    $('search-results').replaceChildren();
    setSearchStatus('');
    renderFavorites();
    // Bewusst kein focus(): die Tastatur soll nicht von selbst aufspringen.
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

  function renderResults(places, context = null) {
    $('search-results').replaceChildren(
      ...places.map((place) =>
        placeRow({
          title: place.title,
          subtitle: [placeDistance(place), place.subtitle].filter(Boolean).join(' · '),
          onSelect: () => choosePlace(place, context),
          action: iconButton(ICONS.star, 'Als Favorit speichern', false, () => openFavoriteDialog(place)),
        }),
      ),
    );
  }

  // ---------- Unterwegs: Tankstelle, Café, Rastplatz ----------

  function renderCategories() {
    $('place-categories').replaceChildren(
      ...PLACE_CATEGORIES.map((category) => {
        const button = document.createElement('button');
        button.className = 'chip-btn';
        button.textContent = category.label;
        button.addEventListener('click', () => runCategorySearch(category));
        return button;
      }),
    );
  }

  async function runCategorySearch(category) {
    const context = getRouteContext?.() ?? null;
    if (stops.length && !context) showSearch(Math.max(0, stops.length - 1));
    else setView('search');
    $('planner-title').textContent = category.label;
    $('planner-back').hidden = stops.length === 0;
    $('search-input').value = '';
    $('search-results').replaceChildren();
    $('favorites-block').hidden = true;

    searchAbort?.abort();
    searchAbort = new AbortController();
    const { signal } = searchAbort;
    setSearchStatus(context?.route ? 'Suche entlang der Route …' : 'Suche in der Nähe …');
    try {
      const places = await findPlaces(category, {
        origin: getOrigin(),
        route: context?.route,
        fromAlong: context?.fromAlong,
        signal,
      });
      if (signal.aborted) return;
      renderResults(places, context);
      setSearchStatus(places.length ? '' : `Nichts gefunden – ${category.label} scheint hier weit weg zu sein.`);
    } catch (err) {
      if (err.name !== 'AbortError') setSearchStatus(err.message);
    }
  }

  /** „in 12 km, 400 m Umweg“ bzw. „2,4 km entfernt“ */
  function placeDistance(place) {
    if (place.aheadMeters != null) {
      const detour = place.detourMeters > 150 ? `, ${formatMeters(place.detourMeters)} Umweg` : '';
      return `in ${formatMeters(place.aheadMeters)}${detour}`;
    }
    if (place.distanceMeters != null) return `${formatMeters(place.distanceMeters)} entfernt`;
    return '';
  }

  async function choosePlace(place, context) {
    // Während der Fahrt kommt der Halt sofort in die laufende Route, sonst in die Planung.
    if (context?.active && onQuickStop) {
      close();
      await onQuickStop(place);
      return;
    }
    selectPlace(place);
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

  // ---------- Rundtour ----------

  function renderTour() {
    const unit = TOUR_UNITS[plan.unit];
    document.querySelectorAll('[data-tour-unit]').forEach((button) => {
      button.setAttribute('aria-checked', String(button.dataset.tourUnit === plan.unit));
    });
    const slider = $('tour-slider');
    Object.assign(slider, { min: unit.min, max: unit.max, step: unit.step });
    slider.value = plan[unit.key];

    $('tour-presets').replaceChildren(
      ...unit.presets.map((value) => {
        const chip = document.createElement('button');
        chip.className = 'chip-btn';
        chip.dataset.value = value;
        chip.textContent = plan.unit === 'time' ? `${value} h` : `${value} km`;
        chip.addEventListener('click', () => {
          plan[unit.key] = value;
          onPlanChange();
          slider.value = value;
          renderTourValue();
        });
        return chip;
      }),
    );
    renderTourValue();

    document.querySelectorAll('[data-direction]').forEach((button) => {
      const value = button.dataset.direction === '' ? null : Number(button.dataset.direction);
      button.setAttribute('aria-pressed', String(value === plan.direction));
    });
  }

  function renderTourValue() {
    const unit = TOUR_UNITS[plan.unit];
    const value = plan[unit.key];
    $('tour-value').textContent = plan.unit === 'time' ? formatHours(value) : `${value} km`;
    $('tour-presets')
      .querySelectorAll('.chip-btn')
      .forEach((chip) => chip.setAttribute('aria-pressed', String(Number(chip.dataset.value) === value)));
  }

  async function calculateTour() {
    const origin = getOrigin();
    const error = $('tour-error');
    if (!origin) {
      error.textContent = 'Noch kein GPS-Signal – bitte kurz warten.';
      error.hidden = false;
      return;
    }
    error.hidden = true;
    const button = $('calc-tour');
    button.disabled = true;
    button.textContent = 'Suche Rundtouren …';
    try {
      const spec = { unit: plan.unit, km: plan.km, hours: plan.hours, direction: plan.direction };
      await onTourCalculate(spec, { ...routeOptions }, (done, total) => {
        button.textContent = `Suche Rundtouren … ${done}/${total}`;
      });
      close();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = 'Rundtouren finden';
    }
  }

  // ---------- Optionen & Berechnen ----------

  function renderOptions(containerId) {
    const container = $(containerId);
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

function formatMeters(meters) {
  if (meters < 950) return `${Math.max(50, Math.round(meters / 50) * 50)} m`;
  return `${(meters / 1000).toLocaleString('de-DE', { maximumFractionDigits: meters < 9500 ? 1 : 0 })} km`;
}

function formatHours(hours) {
  const whole = Math.floor(hours);
  const minutes = Math.round((hours - whole) * 60);
  return minutes ? `${whole}:${String(minutes).padStart(2, '0')} h` : `${whole} h`;
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
