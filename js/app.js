import * as maplibregl from 'https://cdn.jsdelivr.net/npm/maplibre-gl@6.9.1/dist/maplibre-gl.mjs';
// Die ?v=… Anhänge sorgen dafür, dass das iPhone nach einem Update die neuen Dateien lädt.
// Bei jeder Änderung APP_VERSION und alle ?v= (in allen js-Dateien und index.html) gemeinsam erhöhen.
import { buildStyle } from './map-style.js?v=1.2.1';
import { DemoRide } from './demo.js?v=1.2.1';
import { angleDiff, bearing, distance } from './geo.js?v=1.2.1';
import { createPlanner } from './planner.js?v=1.2.1';
import { fetchRoutes, RouteProgress } from './routing.js?v=1.2.1';

const APP_VERSION = '1.2.1';
const ARRIVAL_METERS = 30;

const $ = (id) => document.getElementById(id);
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const lerp = (a, b, t) => a + (b - a) * t;

const ICONS = {
  heading: '<svg class="i" viewBox="0 0 24 24"><path d="M12 3l7 18-7-4-7 4z"/></svg>',
  north: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.5 15.5v-7l5 7v-7"/></svg>',
  night: '<svg class="i" viewBox="0 0 24 24"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5z"/></svg>',
  settings: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  route: '<svg class="i" viewBox="0 0 24 24"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>',
  day: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
};

const SETTINGS_KEY = 'motodash.settings';
const GPS_STALE_MS = 20000;
const settings = loadSettings();

const state = {
  mode: null, // null | 'live' | 'demo'
  follow: true,
  zoomOffset: 0,
  heading: null, // letzte verlässliche Fahrtrichtung
  speedKmh: 0,
  lastFix: null,
  lastFixAt: 0,
  easingUntil: 0, // solange läuft eine Kamera-Animation, die nicht überschrieben werden soll
  touching: false, // Finger auf der Karte – Kamera pausiert, sonst bricht MapLibre die Geste ab
  pinched: false, // während der aktuellen Berührung lagen zwei Finger auf der Karte
  userZooming: false, // Mausrad/Doppeltipp-Zoom läuft
  dragCancelAt: 0,
  watchId: null,
  demo: null,
};

// Was gerade gezeichnet wird – zwischen zwei GPS-Punkten weich interpoliert.
const view = { lng: null, lat: null, heading: null, zoom: 16 };
const anim = { from: null, to: null, start: 0, duration: 1000, lastTargetAt: 0, raf: 0 };
const wake = { lock: null, wanted: false };
// phase: null (keine Route) | 'choose' (Routen zur Auswahl) | 'active' (Route wird gefahren)
const routeState = { phase: null, routes: [], selected: 0, stops: [], progress: null, markers: [] };
const clockFormat = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });

let map;
let marker;
let planner;
const markerEl = document.createElement('div');
markerEl.className = 'rider';
markerEl.innerHTML = '<svg viewBox="0 0 48 48"><path d="M24 5 L40 42 L24 33 L8 42 Z"/></svg>';

init();

function init() {
  applyTheme();
  applyLayout();
  renderButtons();
  document.querySelectorAll('.app-version').forEach((el) => (el.textContent = APP_VERSION));
  tick();
  setInterval(tick, 1000);
  showInstallHint();

  try {
    map = new maplibregl.Map({
      container: 'map',
      style: buildStyle(settings.theme),
      center: [10.45, 51.16],
      zoom: 5.5,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      maxPitch: 60,
    });
  } catch (err) {
    console.error(err);
    showStartError('Die Karte kann auf diesem Gerät nicht angezeigt werden (WebGL2 wird benötigt).');
    document.querySelectorAll('#start .btn').forEach((btn) => (btn.disabled = true));
    return;
  }

  map.touchZoomRotate.disableRotation();
  marker = new maplibregl.Marker({ element: markerEl, rotationAlignment: 'map', pitchAlignment: 'map' });

  const container = map.getContainer();
  container.addEventListener('touchstart', onMapTouch, { passive: true });
  container.addEventListener('touchend', onMapTouch, { passive: true });
  container.addEventListener('touchcancel', onMapTouch, { passive: true });
  // iOS soll nicht die ganze Seite zoomen, wenn zwei Finger auf dem Bildschirm liegen.
  document.addEventListener('gesturestart', (e) => e.preventDefault());

  map.on('dragstart', onUserDrag);
  map.on('zoomstart', (e) => {
    if (e.originalEvent && !state.touching && state.follow) state.userZooming = true;
  });
  map.on('zoomend', () => {
    if (!state.userZooming) return;
    state.userZooming = false;
    keepZoomAndReturn();
  });
  map.on('resize', () => {
    if (state.follow && view.lng != null) map.jumpTo(cameraFor());
  });

  $('btn-live').addEventListener('click', () => start('live'));
  $('btn-demo').addEventListener('click', () => start('demo'));
  $('demo-badge').addEventListener('click', stop);
  $('btn-zoom-in').addEventListener('click', () => zoomBy(1));
  $('btn-zoom-out').addEventListener('click', () => zoomBy(-1));
  $('btn-recenter').addEventListener('click', recenter);
  $('display').addEventListener('click', () => state.mode && requestWakeLock());

  $('btn-view').addEventListener('click', () => {
    settings.view = settings.view === 'heading' ? 'north' : 'heading';
    saveSettings();
    renderButtons();
    recenter();
  });

  $('btn-theme').addEventListener('click', () => {
    settings.theme = settings.theme === 'night' ? 'day' : 'night';
    saveSettings();
    applyTheme();
    renderButtons();
    map.setStyle(buildStyle(settings.theme, { route: routeGeoJSON() }));
  });

  planner = createPlanner({
    getOrigin: () => (state.lastFix ? { lng: state.lastFix.lng, lat: state.lastFix.lat } : null),
    routeOptions: settings.route,
    onOptionsChange: (options) => {
      settings.route = options;
      saveSettings();
    },
    onCalculate: showRouteChoices,
  });
  $('btn-route').addEventListener('click', () => planner.open());
  $('route-start').addEventListener('click', startRoute);
  $('route-edit').addEventListener('click', () => planner.open());
  $('route-cancel').addEventListener('click', () => clearRoute({ keepStops: true }));
  $('route-end').addEventListener('click', onEndRouteTap);
  map.on('click', 'route-hit', (e) => {
    if (routeState.phase === 'choose') selectRoute(e.features[0].properties.index);
  });

  $('btn-settings').addEventListener('click', () => ($('settings').hidden = false));
  $('settings-close').addEventListener('click', () => ($('settings').hidden = true));
  $('settings').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) $('settings').hidden = true;
  });
  document.querySelectorAll('[data-cockpit-option]').forEach((btn) => {
    btn.addEventListener('click', () => {
      settings.cockpit = btn.dataset.cockpitOption;
      saveSettings();
      applyLayout();
    });
  });

  document.addEventListener('visibilitychange', () => {
    if (wake.wanted && !wake.lock && document.visibilityState === 'visible') requestWakeLock();
  });
}

// ---------- Start / Stopp ----------

function start(mode) {
  hideStartError();
  if (mode === 'live') {
    if (!('geolocation' in navigator)) {
      return showStartError('Dieses Gerät bietet keinen Standortzugriff an.');
    }
    if (!window.isSecureContext) {
      return showStartError('Der Standort funktioniert nur über eine sichere Verbindung (https://).');
    }
  }

  state.mode = mode;
  $('start').hidden = true;
  $('demo-badge').hidden = mode !== 'demo';
  setFollow(true);
  requestWakeLock();
  setTimeout(collapseAttribution, 8000);

  if (mode === 'live') {
    setChip('gps', 'warn', 'GPS sucht …');
    state.watchId = navigator.geolocation.watchPosition(
      (pos) => onPosition(fromGeolocation(pos)),
      onGeoError,
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
    );
  } else {
    state.demo = new DemoRide(onPosition);
    state.demo.start();
  }
}

function stop() {
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.demo?.stop();
  Object.assign(state, {
    mode: null,
    watchId: null,
    demo: null,
    heading: null,
    speedKmh: 0,
    lastFix: null,
    lastFixAt: 0,
    zoomOffset: 0,
  });
  cancelAnimationFrame(anim.raf);
  anim.raf = 0;
  Object.assign(view, { lng: null, lat: null, heading: null, zoom: 16 });
  marker.remove();
  releaseWakeLock();
  clearRoute();

  $('speed').textContent = '–';
  $('altitude').textContent = '–';
  setChip('gps', 'off', 'GPS aus');
  setFollow(true);
  map.easeTo({ bearing: 0, pitch: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 400 });
  $('demo-badge').hidden = true;
  $('start').hidden = false;
}

// ---------- Position ----------

function fromGeolocation(pos) {
  const c = pos.coords;
  return {
    lng: c.longitude,
    lat: c.latitude,
    accuracy: c.accuracy,
    speed: c.speed,
    heading: c.heading,
    altitude: c.altitude,
    timestamp: pos.timestamp,
  };
}

function onPosition(fix) {
  const prev = state.lastFix;
  let speed = Number.isFinite(fix.speed) && fix.speed >= 0 ? fix.speed : null;
  let heading = Number.isFinite(fix.heading) && fix.heading >= 0 ? fix.heading : null;

  // Falls das GPS Tempo oder Richtung nicht mitliefert: aus den letzten zwei Punkten berechnen.
  if (prev) {
    const moved = distance([prev.lng, prev.lat], [fix.lng, fix.lat]);
    const seconds = (fix.timestamp - prev.timestamp) / 1000;
    if (speed == null && seconds > 0) speed = moved / seconds;
    if (heading == null && moved > 8) heading = bearing([prev.lng, prev.lat], [fix.lng, fix.lat]);
  }

  const kmh = (speed ?? 0) * 3.6;
  state.speedKmh = kmh < 3 ? 0 : kmh; // GPS-Zittern im Stand ignorieren
  if (heading != null && state.speedKmh >= 5) state.heading = heading;
  state.lastFix = fix;
  state.lastFixAt = Date.now();

  $('speed').textContent = Math.round(state.speedKmh);
  $('altitude').textContent = Number.isFinite(fix.altitude) ? `${Math.round(fix.altitude)} m` : '–';
  setChip('gps', ...gpsStatus(fix));

  animateTo({ lng: fix.lng, lat: fix.lat, heading: state.heading, zoom: autoZoom(state.speedKmh) });
  updateRouteProgress();
}

function gpsStatus(fix) {
  if (state.mode === 'demo') return ['ok', 'Demo-GPS'];
  const accuracy = Math.round(fix.accuracy);
  if (accuracy <= 15) return ['ok', `GPS ±${accuracy} m`];
  if (accuracy <= 50) return ['warn', `GPS ±${accuracy} m`];
  return ['bad', `GPS ungenau ±${accuracy} m`];
}

function onGeoError(err) {
  if (err.code === err.PERMISSION_DENIED) {
    stop();
    showStartError(
      'Kein Zugriff auf deinen Standort. Auf dem iPhone: Einstellungen → Datenschutz & Sicherheit → ' +
        'Ortungsdienste → Safari-Websites → „Beim Verwenden der App“. Danach die Seite neu laden.',
    );
  } else if (err.code === err.POSITION_UNAVAILABLE) {
    setChip('gps', 'bad', 'Kein GPS-Signal');
  } else {
    setChip('gps', 'warn', 'GPS sucht …');
  }
}

// ---------- Kamera ----------

/** Je schneller, desto weiter herausgezoomt – man sieht mehr von der Strecke. */
function autoZoom(kmh) {
  return clamp(17.2 - kmh * 0.022, 14.3, 17.2);
}

function cameraFor() {
  const headingUp = settings.view === 'heading';
  const height = map.getContainer().clientHeight;
  return {
    center: [view.lng, view.lat],
    zoom: view.zoom + state.zoomOffset,
    bearing: headingUp ? (view.heading ?? 0) : 0,
    pitch: headingUp ? 45 : 0,
    // In Fahrtrichtung sitzt der Fahrer im unteren Drittel, damit man mehr vorausschaut.
    padding: { top: headingUp ? Math.round(height * 0.38) : 0, bottom: 0, left: 0, right: 0 },
  };
}

function animateTo(target) {
  const now = performance.now();

  if (view.lng == null) {
    Object.assign(view, target);
    anim.lastTargetAt = now;
    marker.setLngLat([view.lng, view.lat]).addTo(map);
    state.easingUntil = now + 2000;
    render(now);
    setFollow(state.follow);
    if (state.follow) map.flyTo({ ...cameraFor(), duration: 1800, essential: true });
    return;
  }

  anim.from = { ...view };
  anim.to = target;
  anim.start = now;
  anim.duration = clamp(now - anim.lastTargetAt, 250, 1500);
  anim.lastTargetAt = now;
  if (!anim.raf) anim.raf = requestAnimationFrame(frame);
}

function frame(now) {
  const { from, to } = anim;
  const t = clamp((now - anim.start) / anim.duration, 0, 1);
  view.lng = lerp(from.lng, to.lng, t);
  view.lat = lerp(from.lat, to.lat, t);
  view.zoom = lerp(from.zoom, to.zoom, t);
  view.heading =
    from.heading == null || to.heading == null
      ? to.heading
      : (from.heading + angleDiff(from.heading, to.heading) * t + 360) % 360;
  render(now);
  anim.raf = t < 1 ? requestAnimationFrame(frame) : 0;
}

function render(now) {
  marker.setLngLat([view.lng, view.lat]);
  marker.setRotation(view.heading ?? 0);
  markerEl.classList.toggle('has-heading', view.heading != null);
  const userIsGesturing = state.touching || state.userZooming;
  if (state.follow && !userIsGesturing && now >= state.easingUntil) map.jumpTo(cameraFor());
}

function setFollow(follow) {
  state.follow = follow;
  // Während der Routenwahl bringen „Abbrechen“/„Starten“ zurück zur Position.
  $('btn-recenter').hidden = follow || view.lng == null || routeState.phase === 'choose';
  // Beim Mitfahren um die eigene Position zoomen, beim freien Umschauen um die Finger.
  const around = follow ? { around: 'center' } : true;
  map?.touchZoomRotate.enable(around);
  map?.scrollZoom.enable(around);
}

// ---------- Gesten ----------

function onMapTouch(e) {
  const fingers = e.touches.length;
  state.touching = fingers > 0;

  if (fingers >= 2 && !state.pinched) {
    state.pinched = true;
    // Der erste Finger hat das Mitfahren kurz beendet, aber eigentlich wollte man zoomen.
    if (!state.follow && state.mode && performance.now() - state.dragCancelAt < 600) setFollow(true);
  }

  if (fingers === 0) {
    const wasPinch = state.pinched;
    state.pinched = false;
    if (wasPinch) keepZoomAndReturn();
    else if (state.follow) returnToRider(250);
  }
}

function onUserDrag(e) {
  if (!e.originalEvent || !state.mode) return;
  if (state.pinched || e.originalEvent.touches?.length >= 2) return;
  setFollow(false);
  state.dragCancelAt = performance.now();
}

/** Gezoomte Stufe übernehmen und weiter mitfahren. */
function keepZoomAndReturn() {
  if (!state.follow || view.lng == null) return;
  state.zoomOffset = clamp(map.getZoom() - view.zoom, -8, 4);
  returnToRider(300);
}

function returnToRider(duration) {
  if (view.lng == null) return;
  state.easingUntil = performance.now() + duration + 50;
  map.easeTo({ ...cameraFor(), duration, essential: true });
}

function recenter() {
  setFollow(true);
  if (view.lng == null) return;
  state.easingUntil = performance.now() + 650;
  map.easeTo({ ...cameraFor(), duration: 600, essential: true });
}

function zoomBy(delta) {
  if (state.follow && view.lng != null) {
    state.zoomOffset = clamp(state.zoomOffset + delta, -8, 4);
    state.easingUntil = performance.now() + 300;
    map.easeTo({ ...cameraFor(), duration: 280 });
  } else {
    map.easeTo({ zoom: map.getZoom() + delta, duration: 280 });
  }
}

// ---------- Route ----------

async function showRouteChoices(points, options) {
  const routes = await fetchRoutes(points, options);
  Object.assign(routeState, { phase: 'choose', routes, selected: 0, stops: points.slice(1), progress: null });

  $('route-info').hidden = true;
  $('route-chooser').hidden = false;
  $('app').classList.add('is-choosing');
  $('route-start-label').textContent = routes.length > 1 ? 'Diese Route starten' : 'Route starten';
  renderRouteChoices();
  renderRoute();
  renderStopMarkers();
  setFollow(false);
  // Das Auswahlfenster muss erst sichtbar sein, damit die Karte daneben eingepasst werden kann.
  requestAnimationFrame(fitRoutesIntoView);
}

function selectRoute(index) {
  routeState.selected = index;
  renderRouteChoices();
  renderRoute();
}

function startRoute() {
  const route = routeState.routes[routeState.selected];
  routeState.phase = 'active';
  routeState.progress = new RouteProgress(route);
  $('route-chooser').hidden = true;
  $('app').classList.remove('is-choosing');
  $('route-info').hidden = false;
  renderRoute();
  if (state.mode === 'demo') state.demo.followRoute(route.coords);
  updateRouteProgress();
  recenter();
}

/** @param keepStops true = Ziele bleiben im Planer zum Bearbeiten erhalten */
function clearRoute({ keepStops = false } = {}) {
  Object.assign(routeState, { phase: null, routes: [], selected: 0, stops: [], progress: null });
  if (!keepStops) planner?.clearStops();
  $('route-chooser').hidden = true;
  $('app').classList.remove('is-choosing');
  $('route-info').hidden = true;
  if (!map) return;
  renderRoute();
  renderStopMarkers();
  if (state.mode && !state.follow) recenter();
}

function updateRouteProgress() {
  if (routeState.phase !== 'active' || !state.lastFix) return;
  const { remainingMeters, remainingSeconds } = routeState.progress.update(state.lastFix.lng, state.lastFix.lat);
  $('route-eta').textContent = clockFormat.format(new Date(Date.now() + remainingSeconds * 1000));
  $('route-remaining').textContent = `${formatDistance(remainingMeters)} · ${formatDuration(remainingSeconds)}`;
  if (remainingMeters < ARRIVAL_METERS) {
    clearRoute();
    showToast('Ziel erreicht');
  }
}

/** Route beenden erst beim zweiten Tippen – gegen versehentliches Beenden während der Fahrt. */
function onEndRouteTap() {
  const button = $('route-end');
  if (button.classList.contains('is-confirm')) {
    button.classList.remove('is-confirm');
    clearRoute();
    return;
  }
  button.classList.add('is-confirm');
  setTimeout(() => button.classList.remove('is-confirm'), 3000);
}

function routeGeoJSON() {
  const { phase, routes, selected } = routeState;
  return {
    type: 'FeatureCollection',
    features: routes
      .map((route, index) => ({
        type: 'Feature',
        properties: { index, selected: index === selected },
        geometry: { type: 'LineString', coordinates: route.coords },
      }))
      .filter((feature) => phase !== 'active' || feature.properties.selected),
  };
}

function renderRoute() {
  const source = map.getSource('route');
  if (source) source.setData(routeGeoJSON());
  else map.once('style.load', renderRoute); // Karte lädt noch – danach zeichnen
}

function renderStopMarkers() {
  routeState.markers.forEach((m) => m.remove());
  routeState.markers = routeState.stops.map((stop, i) => {
    const el = document.createElement('div');
    const isDestination = i === routeState.stops.length - 1;
    el.className = `stop-marker${isDestination ? ' is-destination' : ''}`;
    if (isDestination) el.innerHTML = ICONS.route;
    else el.textContent = String(i + 1);
    return new maplibregl.Marker({ element: el }).setLngLat([stop.lng, stop.lat]).addTo(map);
  });
}

function renderRouteChoices() {
  const now = Date.now();
  $('route-choice-list').replaceChildren(
    ...routeState.routes.map((route, index) => {
      const card = document.createElement('button');
      card.className = 'route-card';
      card.setAttribute('aria-pressed', String(index === routeState.selected));
      card.innerHTML = '<div class="rc-time"></div><div class="rc-sub"></div><div class="rc-sub"></div><div class="rc-tags"></div>';
      const [distanceLine, arrivalLine] = card.querySelectorAll('.rc-sub');
      card.querySelector('.rc-time').textContent = formatDuration(route.timeSeconds);
      distanceLine.textContent = formatDistance(route.lengthMeters);
      arrivalLine.textContent = `an ${clockFormat.format(new Date(now + route.timeSeconds * 1000))}`;
      const tags = [
        index === 0 && routeState.routes.length > 1 && 'Empfohlen',
        route.hasHighway && 'Autobahn',
        route.hasToll && 'Maut',
        route.hasFerry && 'Fähre',
      ].filter(Boolean);
      card.querySelector('.rc-tags').replaceChildren(
        ...tags.map((tag) => Object.assign(document.createElement('span'), { className: 'rc-tag', textContent: tag })),
      );
      card.addEventListener('click', () => selectRoute(index));
      return card;
    }),
  );
}

/** Alle Routen so zeigen, dass sie nicht unter dem Auswahlfenster oder den Knöpfen liegen. */
function fitRoutesIntoView() {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const route of routeState.routes) {
    for (const [lng, lat] of route.coords) {
      minLng = Math.min(minLng, lng);
      maxLng = Math.max(maxLng, lng);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
    }
  }
  if (!Number.isFinite(minLng)) return;

  const wrap = $('map-wrap').getBoundingClientRect();
  const chooser = $('route-chooser').getBoundingClientRect();
  const fabs = document.querySelector('.fabs').getBoundingClientRect();
  const badge = $('demo-badge').getBoundingClientRect();
  const padding = { top: 50, bottom: 30, left: 30, right: 30 };
  if (!$('demo-badge').hidden) padding.top = badge.bottom - wrap.top + 24;

  if (chooser.width > wrap.width * 0.6) {
    padding.bottom = wrap.bottom - chooser.top + 20; // Auswahl unten (Hochformat)
  } else if (chooser.left - wrap.left < wrap.right - chooser.right) {
    padding.left = chooser.right - wrap.left + 20; // Auswahl links
  } else {
    padding.right = wrap.right - chooser.left + 20; // Auswahl rechts
  }
  if (fabs.left - wrap.left < wrap.right - fabs.right) padding.left = Math.max(padding.left, fabs.right - wrap.left + 16);
  else padding.right = Math.max(padding.right, wrap.right - fabs.left + 16);

  map.jumpTo({ bearing: 0, pitch: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 } });
  map.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding, maxZoom: 15, duration: 700 });
}

function formatDistance(meters) {
  if (meters < 950) return `${Math.max(10, Math.round(meters / 10) * 10)} m`;
  if (meters < 10000) {
    return `${(meters / 1000).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`;
  }
  return `${Math.round(meters / 1000).toLocaleString('de-DE')} km`;
}

function formatDuration(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')} h`;
}

let toastTimer = 0;
function showToast(text) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').hidden = true), 4000);
}

// ---------- Bildschirm an lassen ----------

async function requestWakeLock() {
  wake.wanted = true;
  if (!('wakeLock' in navigator)) {
    setChip('display', 'warn', 'Display: Auto-Sperre');
    return;
  }
  try {
    const lock = await navigator.wakeLock.request('screen');
    wake.lock = lock;
    setChip('display', 'ok', 'Display an');
    lock.addEventListener('release', () => {
      if (wake.lock === lock) wake.lock = null;
      if (wake.wanted) setChip('display', 'warn', 'Display · tippen');
    });
  } catch {
    setChip('display', 'warn', 'Display · tippen');
  }
}

function releaseWakeLock() {
  wake.wanted = false;
  wake.lock?.release();
  wake.lock = null;
  setChip('display', 'off', 'Display');
}

// ---------- Oberfläche ----------

function tick() {
  $('clock').textContent = clockFormat.format(new Date());
  if (state.mode === 'live' && state.lastFixAt && Date.now() - state.lastFixAt > GPS_STALE_MS) {
    setChip('gps', 'bad', 'GPS-Signal schwach');
    $('speed').textContent = '–';
  }
}

/** Quellenangabe nach dem Start zum (i)-Knopf einklappen – sie bleibt per Tippen erreichbar. */
function collapseAttribution() {
  const attribution = document.querySelector('.maplibregl-ctrl-attrib.maplibregl-compact');
  attribution?.classList.remove('maplibregl-compact-show');
  attribution?.removeAttribute('open');
}

function setChip(id, level, text) {
  const chip = $(id);
  chip.dataset.level = level;
  chip.querySelector('span').textContent = text;
}

function renderButtons() {
  const headingUp = settings.view === 'heading';
  const night = settings.theme === 'night';
  $('btn-view').innerHTML = `${headingUp ? ICONS.heading : ICONS.north}<span>${headingUp ? 'Fahrtrichtung' : 'Norden oben'}</span>`;
  $('btn-theme').innerHTML = `${night ? ICONS.night : ICONS.day}<span>${night ? 'Nacht' : 'Tag'}</span>`;
  $('btn-route').innerHTML = `${ICONS.route}<span>Ziel</span>`;
  $('btn-settings').innerHTML = `${ICONS.settings}<span>Einstellungen</span>`;
}

/** Cockpit-Seite im Querformat (links/rechts). */
function applyLayout() {
  document.documentElement.dataset.cockpit = settings.cockpit;
  document.querySelectorAll('[data-cockpit-option]').forEach((btn) => {
    btn.setAttribute('aria-checked', String(btn.dataset.cockpitOption === settings.cockpit));
  });
}

function applyTheme() {
  document.documentElement.dataset.theme = settings.theme;
  document.querySelector('meta[name="theme-color"]').content = settings.theme === 'day' ? '#eef0f3' : '#0b0d10';
}

function showInstallHint() {
  const isIOS =
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  $('install-hint').hidden = !(isIOS && !isStandalone);
}

function showStartError(message) {
  $('start-error').textContent = message;
  $('start-error').hidden = false;
}

function hideStartError() {
  $('start-error').hidden = true;
}

function loadSettings() {
  const defaults = {
    theme: 'night',
    view: 'heading',
    cockpit: 'right',
    route: { avoidHighways: false, avoidTolls: false, avoidFerries: false },
  };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY)) };
  } catch {
    return defaults;
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Privater Modus o. Ä. – Einstellungen gelten dann nur für diese Sitzung.
  }
}
