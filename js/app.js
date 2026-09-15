import * as maplibregl from 'https://cdn.jsdelivr.net/npm/maplibre-gl@6.9.1/dist/maplibre-gl.mjs';
import { buildStyle } from './map-style.js';
import { DemoRide } from './demo.js';
import { angleDiff, bearing, distance } from './geo.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const lerp = (a, b, t) => a + (b - a) * t;

const ICONS = {
  heading: '<svg class="i" viewBox="0 0 24 24"><path d="M12 3l7 18-7-4-7 4z"/></svg>',
  north: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.5 15.5v-7l5 7v-7"/></svg>',
  night: '<svg class="i" viewBox="0 0 24 24"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5z"/></svg>',
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
  watchId: null,
  demo: null,
};

// Was gerade gezeichnet wird – zwischen zwei GPS-Punkten weich interpoliert.
const view = { lng: null, lat: null, heading: null, zoom: 16 };
const anim = { from: null, to: null, start: 0, duration: 1000, lastTargetAt: 0, raf: 0 };
const wake = { lock: null, wanted: false };
const clockFormat = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });

let map;
let marker;
const markerEl = document.createElement('div');
markerEl.className = 'rider';
markerEl.innerHTML = '<svg viewBox="0 0 48 48"><path d="M24 5 L40 42 L24 33 L8 42 Z"/></svg>';

init();

function init() {
  applyTheme();
  renderButtons();
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

  const stopFollowing = (e) => {
    if (e.originalEvent && state.mode) setFollow(false);
  };
  map.on('dragstart', stopFollowing);
  map.on('zoomstart', stopFollowing);
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
    map.setStyle(buildStyle(settings.theme));
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
  if (state.follow && now >= state.easingUntil) map.jumpTo(cameraFor());
}

function setFollow(follow) {
  state.follow = follow;
  $('btn-recenter').hidden = follow || view.lng == null;
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

// ---------- Bildschirm an lassen ----------

async function requestWakeLock() {
  wake.wanted = true;
  if (!('wakeLock' in navigator)) {
    setChip('display', 'warn', 'Auto-Sperre beachten');
    return;
  }
  try {
    const lock = await navigator.wakeLock.request('screen');
    wake.lock = lock;
    setChip('display', 'ok', 'Bildschirm bleibt an');
    lock.addEventListener('release', () => {
      if (wake.lock === lock) wake.lock = null;
      if (wake.wanted) setChip('display', 'warn', 'Bildschirm-Sperre · tippen');
    });
  } catch {
    setChip('display', 'warn', 'Bildschirm-Sperre · tippen');
  }
}

function releaseWakeLock() {
  wake.wanted = false;
  wake.lock?.release();
  wake.lock = null;
  setChip('display', 'off', 'Bildschirm');
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
  const defaults = { theme: 'night', view: 'heading' };
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
