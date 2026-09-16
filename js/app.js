import * as maplibregl from 'https://cdn.jsdelivr.net/npm/maplibre-gl@6.9.1/dist/maplibre-gl.mjs';
// Die ?v=… Anhänge sorgen dafür, dass das iPhone nach einem Update die neuen Dateien lädt.
// Bei jeder Änderung APP_VERSION erhöhen und bei jeder geänderten Datei deren ?v= überall, wo sie geladen wird.
import { buildStyle, routeDoneGradient } from './map-style.js?v=1.4';
import { DemoRide } from './demo.js?v=1.2.1';
import { angleDiff, bearing, distance } from './geo.js?v=1.2.1';
import { createPlanner } from './planner.js?v=1.3';
import { fetchRoutes, fetchSpeedLimits } from './routing.js?v=1.4';
import { findRoundTrips } from './tours.js?v=1.4';
import { Navigation, maneuverIcon, maneuverShort, maneuverTitle } from './navigation.js?v=1.4';
import { setMuted, speak, unlockVoice, voiceSupported } from './voice.js?v=1.4';
import { RideStats } from './ride-stats.js?v=1.6';
import { deleteRide, loadRides, migrateLegacyRide, saveRide, trackGeoJSON } from './rides.js?v=1.6';
import { describeWeather, fetchWeather, rainSummary } from './weather.js?v=1.5';
import * as spotify from './spotify.js?v=1.6';

const APP_VERSION = '1.6.2';
const WEATHER_REFRESH_MS = 10 * 60 * 1000;
const WEATHER_MOVE_METERS = 10000; // nach so viel Strecke neu abfragen
const MUSIC_POLL_MS = 5000;
const MUSIC_KEEP_PAUSED_MS = 15 * 60 * 1000; // pausierte Musik bleibt so lange sichtbar, damit man weiterspielen kann
const MIN_RIDE_METERS = 200; // kürzere Aufnahmen werden nicht gespeichert
// Aus Version 1.5.2/1.5.3: dort merkte sich die App eine „Stumm-Pause“ – falls noch vorhanden, aufräumen.
const LEGACY_MUTED_PAUSE_KEY = 'motodash.mutedPause';
// Farbverlauf der aufgezeichneten Linie nach Tempo (km/h → Farbe)
const TRACK_SPEED_COLORS = [0, '#3ddc84', 50, '#ffd24d', 100, '#ff7a1a', 140, '#ff3b3b'];
const ARRIVAL_METERS = 30;
const REROUTE_COOLDOWN_MS = 8000; // höchstens so oft neu berechnen
const REROUTE_SPEECH_GAP_MS = 60000; // „Route wird neu berechnet“ nicht ständig wiederholen

const $ = (id) => document.getElementById(id);
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const lerp = (a, b, t) => a + (b - a) * t;

const ICONS = {
  heading: '<svg class="i" viewBox="0 0 24 24"><path d="M12 3l7 18-7-4-7 4z"/></svg>',
  north: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.5 15.5v-7l5 7v-7"/></svg>',
  night: '<svg class="i" viewBox="0 0 24 24"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5z"/></svg>',
  settings: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  route: '<svg class="i" viewBox="0 0 24 24"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>',
  play: '<svg class="i" viewBox="0 0 24 24"><path d="M8 5l12 7-12 7z"/></svg>',
  pause: '<svg class="i" viewBox="0 0 24 24"><path d="M8 5v14M16 5v14" stroke-width="3.5"/></svg>',
  voiceOn: '<svg class="i" viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>',
  voiceOff: '<svg class="i" viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9l5 6M22 9l-5 6"/></svg>',
  day: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
};

// Abbiegepfeile fürs Navigations-Banner (weiße Linien auf blauem Grund).
const NAV_ICONS = {
  straight: '<path d="M24 42V8M13 19L24 8l11 11"/>',
  right: '<path d="M14 42V26a8 8 0 0 1 8-8h16M30 10l8 8-8 8"/>',
  slightRight: '<path d="M17 42V27L35 9M23 9h12v12"/>',
  sharpRight: '<path d="M15 8v26M15 34L35 14M25 14h10v10"/>',
  left: '<path d="M34 42V26a8 8 0 0 0-8-8H10M18 10l-8 8 8 8"/>',
  slightLeft: '<path d="M31 42V27L13 9M25 9H13v12"/>',
  sharpLeft: '<path d="M33 8v26M33 34L13 14M23 14H13v10"/>',
  uturn: '<path d="M32 42V18a8 8 0 0 0-16 0v16M8 26l8 8 8-8"/>',
  roundabout: '<path d="M24 43V31M24 31A9 9 0 1 0 15 22H6M11 17l-5 5 5 5"/>',
  flag: '<path d="M14 43V7M14 8h20l-5 7 5 7H14"/>',
  ferry: '<path d="M7 31h34l-5 9H12zM24 31V9M24 10l11 14H24"/>',
  reroute: '<path d="M38 24a14 14 0 1 1-4.1-9.9M38 8v8h-8"/>',
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
  dragEndedFollow: false, // diese Berührung hat das Mitfahren durch Verschieben beendet
  watchId: null,
  demo: null,
};

// Was gerade gezeichnet wird – zwischen zwei GPS-Punkten weich interpoliert.
const view = { lng: null, lat: null, heading: null, zoom: 16 };
const anim = { from: null, to: null, start: 0, duration: 1000, lastTargetAt: 0, raf: 0 };
const wake = { lock: null, wanted: false };
// phase: null (keine Route) | 'choose' (Routen zur Auswahl) | 'active' (Route wird gefahren)
// tour: bei Rundtouren die Anfrage (für „Neue Vorschläge“), sonst null
// nav: laufende Navigation (nur in 'active')
const routeState = {
  phase: null,
  routes: [],
  selected: 0,
  stops: [],
  nav: null,
  markers: [],
  tour: null,
  doneFraction: 0,
  rerouting: false,
  rerouteFailed: false,
  lastRerouteAt: 0,
  lastRerouteSpeechAt: 0,
};
const clockFormat = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });

const weatherState = { data: null, loading: false, failedAt: 0 };
const music = { playback: null, lastPlayingAt: 0, deviceId: null, timer: 0, polling: false, busy: false };

let map;
let marker;
let planner;
// Laufende Aufnahme: { stats, source: 'manual' | 'route', title }
let recording = null;
let summaryMap = null; // Karte in der Auswertung
let summaryRide = null; // gerade angezeigte Aufnahme
let cameFromRideLog = false; // Auswertung aus dem Fahrtenbuch geöffnet – danach wieder dorthin zurück
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
  $('demo-badge').addEventListener('click', stop);
  $('btn-zoom-in').addEventListener('click', () => zoomBy(1));
  $('btn-zoom-out').addEventListener('click', () => zoomBy(-1));
  $('btn-recenter').addEventListener('click', recenter);
  setMuted(settings.voiceMuted);
  $('btn-voice').addEventListener('click', () => {
    settings.voiceMuted = !settings.voiceMuted;
    saveSettings();
    setMuted(settings.voiceMuted);
    renderVoiceButton();
    if (!settings.voiceMuted) speak('Sprachansagen an.', { interrupt: true });
  });
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
    map.setStyle(buildStyle(settings.theme, { route: routeGeoJSON(), doneFraction: routeState.doneFraction }));
  });

  planner = createPlanner({
    getOrigin: currentPosition,
    routeOptions: settings.route,
    onOptionsChange: (options) => {
      settings.route = options;
      saveSettings();
    },
    onCalculate: showRouteChoices,
    plan: settings.plan,
    onPlanChange: saveSettings,
    onTourCalculate: showTourChoices,
  });
  $('route-reroll').addEventListener('click', rerollTours);
  $('btn-route').addEventListener('click', () => planner.open());
  $('route-start').addEventListener('click', startRoute);
  $('route-edit').addEventListener('click', () => planner.open());
  $('route-cancel').addEventListener('click', () => clearRoute({ keepStops: true }));
  $('route-end').addEventListener('click', onEndRouteTap);
  map.on('click', 'route-hit', (e) => {
    if (routeState.phase === 'choose') selectRoute(e.features[0].properties.index);
  });

  $('btn-settings').addEventListener('click', openSettings);
  $('start-settings').addEventListener('click', openSettings);
  $('settings-demo').addEventListener('click', () => {
    $('settings').hidden = true;
    const wasDemo = state.mode === 'demo';
    if (state.mode) stop();
    if (!wasDemo) start('demo');
  });
  $('spotify-connect').addEventListener('click', onSpotifyButton);
  $('ride-end').addEventListener('click', () => {
    $('settings').hidden = true;
    stop();
  });
  $('ride-log').addEventListener('click', () => {
    $('settings').hidden = true;
    openRideLog();
  });
  $('btn-record').addEventListener('click', onRecordTap);
  $('summary-close').addEventListener('click', closeRideSummary);
  $('summary-delete').addEventListener('click', onDeleteRideTap);
  $('rides-close').addEventListener('click', () => ($('rides-sheet').hidden = true));
  migrateLegacyRide();
  $('weather').addEventListener('click', openWeatherSheet);
  $('weather-close').addEventListener('click', () => ($('weather-sheet').hidden = true));
  for (const id of ['weather-sheet', 'rides-sheet']) {
    $(id).addEventListener('click', (e) => {
      if (e.target === e.currentTarget) $(id).hidden = true;
    });
  }
  $('ride-summary').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeRideSummary();
  });
  $('music-toggle').addEventListener('click', toggleMusic);
  $('music-next').addEventListener('click', () => musicCommand(spotify.nextTrack));
  $('music-prev').addEventListener('click', () => musicCommand(spotify.previousTrack));
  handleSpotifyReturn();
  cleanUpLegacyMutedPause();

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
    if (document.visibilityState !== 'visible') return;
    if (wake.wanted && !wake.lock) requestWakeLock();
    pollMusic();
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
  unlockVoice(); // passiert im Tipp auf „Losfahren“ – danach darf iOS jederzeit sprechen
  setTimeout(collapseAttribution, 8000);
  renderRecordButton();
  startMusicPolling();

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
  finishRecording(); // läuft noch eine Aufnahme → speichern und Auswertung zeigen
  stopMusicPolling();
  weatherState.data = null;
  renderWeather();
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
  renderRecordButton();
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
  recording?.stats.add(fix, state.speedKmh);
  maybeRefreshWeather();

  $('speed').textContent = Math.round(state.speedKmh);
  $('altitude').textContent = Number.isFinite(fix.altitude) ? `${Math.round(fix.altitude)} m` : '–';
  setChip('gps', ...gpsStatus(fix));

  animateTo({ lng: fix.lng, lat: fix.lat, heading: state.heading, zoom: autoZoom(state.speedKmh) });
  updateNavigation();
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
  if (e.type === 'touchstart' && fingers === 1) state.dragEndedFollow = false; // neue Berührung

  if (fingers >= 2 && !state.pinched) {
    state.pinched = true;
    // Der erste Finger ist beim Ansetzen zum Zoomen verrutscht und hat das Mitfahren beendet –
    // das zählt nicht. Wer vorher schon frei umhergeschaut hat, bleibt dort.
    if (state.dragEndedFollow) setFollow(true);
  }

  if (fingers === 0) {
    const wasPinch = state.pinched;
    state.pinched = false;
    state.dragEndedFollow = false;
    if (wasPinch) keepZoomAndReturn();
    else if (state.follow) returnToRider(250);
  }
}

function onUserDrag(e) {
  if (!e.originalEvent || !state.mode) return;
  if (state.pinched || e.originalEvent.touches?.length >= 2 || !state.follow) return;
  setFollow(false);
  state.dragEndedFollow = true;
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
  presentChoices({ routes, stops: points.slice(1), tour: null });
}

async function showTourChoices(spec, options, onProgress) {
  const origin = currentPosition();
  if (!origin) throw new Error('Noch kein GPS-Signal – bitte kurz warten.');
  const tours = await findRoundTrips(origin, spec, options, onProgress);
  // Die Zielfahne steht bei Rundtouren am Start.
  presentChoices({ routes: tours, stops: [origin], tour: { origin, spec, options } });
}

/** Andere Rundtouren mit denselben Einstellungen. */
async function rerollTours() {
  const { tour } = routeState;
  if (!tour) return;
  const controls = ['route-reroll', 'route-start', 'route-edit', 'route-cancel'].map($);
  controls.forEach((button) => (button.disabled = true));
  try {
    const tours = await findRoundTrips(tour.origin, tour.spec, tour.options, (done, total) => {
      $('route-chooser-title').textContent = `Suche neue Touren … ${done}/${total}`;
    });
    if (routeState.phase === 'choose') presentChoices({ routes: tours, stops: [tour.origin], tour });
  } catch (err) {
    showToast(err.message, { error: true });
  } finally {
    controls.forEach((button) => (button.disabled = false));
    if (routeState.phase === 'choose') $('route-chooser-title').textContent = 'Rundtour wählen';
  }
}

function presentChoices({ routes, stops, tour }) {
  Object.assign(routeState, { phase: 'choose', routes, selected: 0, stops, nav: null, tour });

  $('route-info').hidden = true;
  $('route-chooser').hidden = false;
  $('app').classList.add('is-choosing');
  $('route-chooser-title').textContent = tour ? 'Rundtour wählen' : 'Route wählen';
  $('route-reroll').hidden = !tour;
  const noun = tour ? 'Tour' : 'Route';
  $('route-start-label').textContent = routes.length > 1 ? `Diese ${noun} starten` : `${noun} starten`;
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
  activateRoute(route);
  $('route-chooser').hidden = true;
  $('app').classList.remove('is-choosing');
  $('app').classList.add('is-navigating');
  $('route-info').hidden = false;
  $('btn-voice').hidden = !voiceSupported;
  renderVoiceButton();
  renderRoute();
  if (state.mode === 'demo') state.demo.followRoute(route.coords);
  // Im Tipp auf „Starten“ sprechen – so erlaubt iOS auch die späteren Ansagen.
  speak(routeState.nav.startAnnouncement(Boolean(routeState.tour)), { interrupt: true });
  // Routen werden automatisch aufgenommen (außer es läuft schon eine eigene Aufnahme).
  const destination = routeState.stops.at(-1);
  startRecording('route', routeState.tour ? 'Rundtour' : `Route nach ${destination?.title ?? 'Ziel'}`);
  updateNavigation();
  recenter();
}

/** Navigation für eine (neue oder neu berechnete) Route aufsetzen. */
function activateRoute(route) {
  routeState.nav = new Navigation(route);
  routeState.rerouteFailed = false;
  setDoneFraction(0, { force: true });
  fetchSpeedLimits(route)
    .then((limits) => (route.speedLimits = limits))
    .catch(() => {}); // ohne Tempolimits weiter navigieren
}

/** @param keepStops true = Ziele bleiben im Planer zum Bearbeiten erhalten */
function clearRoute({ keepStops = false } = {}) {
  const endedActiveRoute = routeState.phase === 'active';
  Object.assign(routeState, { phase: null, routes: [], selected: 0, stops: [], nav: null, tour: null, rerouting: false });
  if (!keepStops) planner?.clearStops();
  $('route-chooser').hidden = true;
  $('app').classList.remove('is-choosing', 'is-navigating');
  $('route-info').hidden = true;
  $('nav-banner').hidden = true;
  $('btn-voice').hidden = true;
  renderSpeedLimit(0);
  // Aufnahme, die mit der Route gestartet wurde, endet auch mit ihr (beendet oder angekommen).
  if (endedActiveRoute && recording?.source === 'route') finishRecording();
  if (!map) return;
  setDoneFraction(0, { force: true });
  renderRoute();
  renderStopMarkers();
  if (state.mode && !state.follow) recenter();
}

function updateNavigation() {
  const { nav } = routeState;
  if (routeState.phase !== 'active' || !nav || !state.lastFix) return;
  const fix = state.lastFix;
  const status = nav.update({
    lng: fix.lng,
    lat: fix.lat,
    accuracy: fix.accuracy,
    speedMps: state.speedKmh / 3.6,
    timestamp: fix.timestamp,
  });

  $('route-eta').textContent = clockFormat.format(new Date(Date.now() + status.remainingSeconds * 1000));
  $('route-remaining').textContent = `${formatDistance(status.remainingMeters)} · ${formatDuration(status.remainingSeconds)}`;
  setDoneFraction(status.along / nav.progress.total);
  renderSpeedLimit(status.speedLimit);

  if (status.remainingMeters < ARRIVAL_METERS) {
    const wasTour = Boolean(routeState.tour);
    clearRoute();
    speak(wasTour ? 'Sie haben die Rundtour geschafft.' : 'Sie haben Ihr Ziel erreicht.', { interrupt: true });
    showToast(wasTour ? 'Rundtour geschafft' : 'Ziel erreicht');
    return;
  }

  if (status.offRoute || routeState.rerouting) {
    renderBannerStatus(routeState.rerouteFailed ? 'Keine Verbindung' : 'Neue Route …', 'Route wird neu berechnet');
    reroute();
    return;
  }

  renderBanner(status);
  if (status.speech) speak(status.speech.text, { interrupt: status.speech.interrupt });
}

/** Von der Route abgekommen: neue Route zu den noch offenen Zwischenzielen bzw. zurück auf die Rundtour. */
async function reroute() {
  const { nav } = routeState;
  const origin = currentPosition();
  const now = Date.now();
  if (!nav || !origin || routeState.rerouting || now - routeState.lastRerouteAt < REROUTE_COOLDOWN_MS) return;

  routeState.rerouting = true;
  routeState.lastRerouteAt = now;
  if (now - routeState.lastRerouteSpeechAt > REROUTE_SPEECH_GAP_MS) {
    routeState.lastRerouteSpeechAt = now;
    speak('Route wird neu berechnet.', { interrupt: true });
  }

  try {
    const targets = nav.remainingWaypoints().map(({ lng, lat, via }) => ({ lng, lat, via }));
    const [route] = await fetchRoutes([origin, ...targets], nav.route.options);
    if (routeState.phase !== 'active' || routeState.nav !== nav) return; // inzwischen beendet
    routeState.routes = [route];
    routeState.selected = 0;
    activateRoute(route);
    renderRoute();
    if (state.mode === 'demo') state.demo.followRoute(route.coords);
  } catch {
    routeState.rerouteFailed = true; // nächster Versuch nach der Wartezeit
  } finally {
    routeState.rerouting = false;
  }
}

function renderBanner(status) {
  const { next, then } = status;
  $('nav-banner').hidden = !next;
  if (!next) return;
  $('nav-banner').classList.remove('is-status');
  setNavIcon($('nb-icon'), maneuverIcon(next));
  $('nb-distance').textContent = formatBannerDistance(status.distanceToNext);
  $('nb-title').textContent = maneuverTitle(next, Boolean(routeState.tour));
  $('nb-then').hidden = !then;
  if (then) {
    setNavIcon($('nb-then-icon'), maneuverIcon(then));
    $('nb-then-text').textContent = maneuverShort(then);
  }
}

function renderBannerStatus(headline, detail) {
  $('nav-banner').hidden = false;
  $('nav-banner').classList.add('is-status');
  setNavIcon($('nb-icon'), 'reroute');
  $('nb-distance').textContent = headline;
  $('nb-title').textContent = detail;
  $('nb-then').hidden = true;
}

function setNavIcon(el, name) {
  if (el.dataset.icon === name) return;
  el.dataset.icon = name;
  el.innerHTML = `<svg viewBox="0 0 48 48" aria-hidden="true">${NAV_ICONS[name] ?? NAV_ICONS.straight}</svg>`;
}

function formatBannerDistance(meters) {
  if (meters < 15) return 'Jetzt';
  if (meters < 1000) {
    const step = meters > 300 ? 50 : 10;
    return `${Math.round(meters / step) * step} m`;
  }
  return formatDistance(meters);
}

/** Tempolimit-Schild und rotes Tempo, wenn deutlich zu schnell. */
function renderSpeedLimit(limit) {
  const sign = $('speed-limit');
  sign.hidden = !limit;
  if (limit) sign.textContent = limit;
  const tooFast = Boolean(limit) && state.speedKmh >= limit + Math.max(5, limit * 0.1);
  sign.classList.toggle('is-over', tooFast);
  $('speed').classList.toggle('is-over', tooFast);
}

/** Gefahrenen Teil der Route grau färben. */
function setDoneFraction(fraction, { force = false } = {}) {
  if (!force && Math.abs(fraction - routeState.doneFraction) < 0.0005) return;
  routeState.doneFraction = fraction;
  if (map?.getLayer('route-done')) {
    map.setPaintProperty('route-done', 'line-gradient', routeDoneGradient(settings.theme, fraction));
  }
}

function renderVoiceButton() {
  $('btn-voice').innerHTML = settings.voiceMuted ? ICONS.voiceOff : ICONS.voiceOn;
  $('btn-voice').setAttribute('aria-label', settings.voiceMuted ? 'Sprachansagen einschalten' : 'Sprachansagen stumm');
  $('btn-voice').classList.toggle('is-muted', settings.voiceMuted);
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
      const isTour = Boolean(routeState.tour);
      const tags = [
        isTour && route.directionLabel,
        !isTour && index === 0 && routeState.routes.length > 1 && 'Empfohlen',
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
  // Genug Rand, damit Start-Pfeil und Zielfahne nicht abgeschnitten werden.
  const padding = { top: 50, bottom: 48, left: 40, right: 40 };
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

  map.resize(); // Cockpit wurde gerade ausgeblendet – Karte ist größer geworden
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

function currentPosition() {
  return state.lastFix ? { lng: state.lastFix.lng, lat: state.lastFix.lat } : null;
}

let toastTimer = 0;
function showToast(text, { error = false } = {}) {
  $('toast').textContent = text;
  $('toast').classList.toggle('is-error', error);
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
  renderWeather();
  $('app').classList.toggle('has-dock', !$('route-info').hidden || !$('music-bar').hidden);
  if (recording) renderRecordButton();
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

function openSettings() {
  $('settings-demo').textContent = state.mode === 'demo' ? 'Demo beenden' : 'Demo-Fahrt starten';
  renderSpotifySetting();
  renderRideSetting();
  $('settings').hidden = false;
}

// ---------- Wetter ----------

function maybeRefreshWeather() {
  const position = currentPosition();
  const now = Date.now();
  if (!position || weatherState.loading || now - weatherState.failedAt < 60000) return;
  const { data } = weatherState;
  const outdated =
    !data ||
    now - data.fetchedAt > WEATHER_REFRESH_MS ||
    distance([data.lng, data.lat], [position.lng, position.lat]) > WEATHER_MOVE_METERS;
  if (!outdated) return;

  weatherState.loading = true;
  fetchWeather(position)
    .then((weather) => {
      weatherState.data = weather;
      weatherState.failedAt = 0;
      renderWeather();
    })
    .catch(() => (weatherState.failedAt = Date.now())) // alte Werte behalten, in einer Minute nochmal
    .finally(() => (weatherState.loading = false));
}

function renderWeather() {
  const { data } = weatherState;
  $('weather').hidden = !data || !state.mode;
  if (!data) return;
  const { icon } = describeWeather(data.code, data.isDay);
  const rain = rainSummary(data);
  $('weather-now').textContent = `${icon} ${Math.round(data.temperature)}°`;
  $('weather-rain').textContent = rain.text;
  $('weather').classList.toggle('is-warn', rain.warn);
}

function openWeatherSheet() {
  const { data } = weatherState;
  if (!data) return;
  const now = describeWeather(data.code, data.isDay);
  const rain = rainSummary(data);
  $('weather-summary').innerHTML =
    '<span class="ws-icon"></span><div><div class="ws-temp"></div><div class="ws-text"></div><div class="ws-text ws-rain"></div></div>';
  $('weather-summary').querySelector('.ws-icon').textContent = now.icon;
  $('weather-summary').querySelector('.ws-temp').textContent = `${Math.round(data.temperature)}°`;
  $('weather-summary').querySelector('.ws-text').textContent = now.text;
  const rainLine = $('weather-summary').querySelector('.ws-rain');
  rainLine.textContent = rain.warn ? rain.text : 'In den nächsten 2 Stunden trocken';
  rainLine.classList.toggle('is-warn', rain.warn);

  // Balken: Regenmenge je 15 Minuten, voll ab 1,5 mm.
  $('weather-bars').replaceChildren(
    ...data.slots.map((slot) => {
      const bar = document.createElement('div');
      bar.className = `rain-bar${slot.mm >= 0.2 ? ' is-rain' : ''}`;
      bar.style.height = `${Math.min(100, (slot.mm / 1.5) * 100)}%`;
      bar.title = `${slot.mm.toLocaleString('de-DE')} mm`;
      return bar;
    }),
  );
  const first = data.slots[0];
  const last = data.slots.at(-1);
  $('weather-bar-labels').innerHTML = '<span></span><span></span>';
  const [from, to] = $('weather-bar-labels').children;
  from.textContent = first ? clockFormat.format(new Date(first.start)) : '';
  to.textContent = last ? clockFormat.format(new Date(last.start + 15 * 60 * 1000)) : '';

  $('weather-hours').replaceChildren(
    ...data.hours.slice(1).map((hour) => {
      const row = document.createElement('li');
      const info = describeWeather(hour.code, hour.isDay);
      row.innerHTML = '<span></span><span class="wh-icon"></span><span class="wh-temp"></span><span class="wh-rain"></span>';
      const [time, iconEl, temp, chance] = row.children;
      time.textContent = clockFormat.format(new Date(hour.time));
      iconEl.textContent = info.icon;
      temp.textContent = `${Math.round(hour.temperature)}°`;
      chance.textContent = `Regen ${hour.rainChance ?? 0} %`;
      chance.classList.toggle('is-warn', (hour.rainChance ?? 0) >= 50);
      return row;
    }),
  );
  $('weather-sheet').hidden = false;
}

// ---------- Musik (Spotify) ----------

function startMusicPolling() {
  stopMusicPolling();
  if (!spotify.isConnected()) return;
  pollMusic();
  music.timer = setInterval(pollMusic, MUSIC_POLL_MS);
}

function stopMusicPolling() {
  clearInterval(music.timer);
  music.timer = 0;
  music.playback = null;
  renderMusic();
}

async function pollMusic() {
  if (!state.mode || !spotify.isConnected() || music.polling || music.busy || document.visibilityState !== 'visible') return;
  music.polling = true;
  try {
    const playback = await spotify.getPlayback();
    if (playback) {
      music.playback = playback;
      if (playback.isPlaying) music.lastPlayingAt = Date.now();
      if (playback.deviceId) music.deviceId = playback.deviceId;
    } else if (music.playback) {
      // Pausiert lässt iOS Spotify im Hintergrund schnell „einschlafen“ – dann meldet Spotify gar nichts mehr.
      // Letzten Titel als pausiert weiter anzeigen, damit man wieder starten kann.
      music.playback = { ...music.playback, isPlaying: false };
    }
  } catch (err) {
    // Nur bei getrennter Verbindung ausblenden – bei Netzproblemen den letzten Stand behalten.
    if (err.code === 'not-connected' || err.code === 'auth') music.playback = null;
  } finally {
    music.polling = false;
    renderMusic();
  }
}

function renderMusic() {
  const playback = music.playback;
  const visible = Boolean(
    state.mode && playback && (playback.isPlaying || Date.now() - music.lastPlayingAt < MUSIC_KEEP_PAUSED_MS),
  );
  $('music-bar').hidden = !visible;
  if (!visible) return;

  $('music-title').textContent = playback.title;
  $('music-artist').textContent = playback.artist;
  const cover = $('music-cover');
  cover.hidden = !playback.cover;
  if (playback.cover && cover.getAttribute('src') !== playback.cover) cover.src = playback.cover;
  $('music-toggle').innerHTML = playback.isPlaying ? ICONS.pause : ICONS.play;
  $('music-toggle').setAttribute('aria-label', playback.isPlaying ? 'Pause' : 'Wiedergabe');
}

async function toggleMusic() {
  const playback = music.playback;
  if (!playback || music.busy) return;
  const wasPlaying = playback.isPlaying;
  playback.isPlaying = !wasPlaying; // sofort anzeigen, Spotify braucht etwa eine Sekunde
  music.lastPlayingAt = Date.now();
  renderMusic();
  const ok = await musicCommand(wasPlaying ? spotify.pause : resumeMusic);
  if (!ok && music.playback) {
    music.playback.isPlaying = wasPlaying;
    renderMusic();
  }
}

/** Weiterspielen – ist Spotify eingeschlafen, gezielt das zuletzt genutzte Gerät ansprechen. */
async function resumeMusic() {
  try {
    await spotify.play();
  } catch (err) {
    if (err.code !== 'no-device' || !music.deviceId) throw err;
    await spotify.play(music.deviceId);
  }
}

/** @returns {Promise<boolean>} ob der Befehl angekommen ist */
async function musicCommand(command) {
  if (music.busy) return false; // noch ein Befehl unterwegs
  music.busy = true;
  let ok = true;
  try {
    await command();
  } catch (err) {
    if (err.code === 'no-device') {
      ok = false;
      showToast('Spotify ist eingeschlafen. Bitte einmal in der Spotify-App auf Play tippen – danach geht es hier wieder.', { error: true });
    } else if (err.code !== 'restricted') {
      ok = false;
      showToast(err.message, { error: true });
    }
  } finally {
    music.busy = false;
  }
  setTimeout(pollMusic, 800);
  return ok;
}

/**
 * Version 1.5.2/1.5.3 hatten eine „Stumm-Pause“ (Lautstärke 0 bzw. stummer Titel in Dauerschleife).
 * Falls die App mitten in so einer Pause geschlossen wurde: Wiederholung/Lautstärke zurückstellen.
 */
async function cleanUpLegacyMutedPause() {
  let hold = null;
  try {
    hold = JSON.parse(localStorage.getItem(LEGACY_MUTED_PAUSE_KEY));
    localStorage.removeItem(LEGACY_MUTED_PAUSE_KEY);
  } catch {
    return;
  }
  if (!hold || !spotify.isConnected()) return;
  if (hold.method === 'volume') {
    await spotify.setVolume(hold.volume, hold.deviceId).catch(() => {});
  } else {
    await spotify.setRepeat(hold.repeatState ?? 'off', hold.deviceId).catch(() => {});
    await spotify.playAt(hold).catch(() => {});
    await spotify.pause().catch(() => {});
  }
}

async function handleSpotifyReturn() {
  const result = await spotify.handleRedirect();
  if (!result) return;
  openSettings();
  renderSpotifySetting(result);
}

function renderSpotifySetting(message) {
  const connected = spotify.isConnected();
  $('spotify-hint').textContent = connected
    ? 'Verbunden. Während der Fahrt erscheint unten auf der Karte eine Musik-Leiste, sobald Spotify spielt.'
    : 'Steuert deine Spotify-Wiedergabe (Spotify Premium nötig). Einmalig eine eigene Spotify-App anlegen und die Client-ID hier eintragen.';
  $('spotify-client').hidden = connected;
  if (!$('spotify-client-id').value) $('spotify-client-id').value = spotify.getClientId();
  $('spotify-redirect').textContent = spotify.redirectUri();
  $('spotify-connect').textContent = connected ? 'Verbindung trennen' : 'Mit Spotify verbinden';

  const box = $('spotify-message');
  box.hidden = !message;
  if (message) {
    box.textContent = message.message;
    box.className = message.ok ? 'note success' : 'error';
  }
}

async function onSpotifyButton() {
  if (spotify.isConnected()) {
    spotify.disconnect();
    stopMusicPolling();
    renderSpotifySetting({ ok: true, message: 'Verbindung getrennt.' });
    return;
  }
  if (state.mode) {
    // Für die Anmeldung verlässt die App kurz die Seite – das würde die laufende Fahrt beenden.
    renderSpotifySetting({ ok: false, message: 'Bitte vor dem Losfahren verbinden – die App wird dafür kurz verlassen.' });
    return;
  }
  const clientId = $('spotify-client-id').value.trim();
  if (!/^[0-9a-f]{32}$/i.test(clientId)) {
    renderSpotifySetting({ ok: false, message: 'Die Client-ID hat 32 Zeichen (0–9 und a–f). Bitte aus dem Spotify-Dashboard kopieren.' });
    return;
  }
  spotify.setClientId(clientId);
  try {
    await spotify.connect();
  } catch (err) {
    renderSpotifySetting({ ok: false, message: err.message });
  }
}

// ---------- Aufnahmen & Fahrtenbuch ----------

/** @param source 'manual' (Knopf) oder 'route' (automatisch beim Routenstart) */
function startRecording(source, title) {
  if (recording || !state.mode) return;
  recording = { stats: new RideStats(), source, title };
  if (state.lastFix) recording.stats.add(state.lastFix, state.speedKmh);
  renderRecordButton();
}

/** Aufnahme beenden, speichern und Auswertung zeigen. */
function finishRecording() {
  if (!recording) return;
  const { stats, source, title } = recording;
  recording = null;
  $('btn-record').classList.remove('is-confirm');
  renderRecordButton();

  const summary = stats.summary();
  if (summary.meters < MIN_RIDE_METERS) {
    showToast('Unter 200 m – nicht gespeichert'); // festes Leerzeichen: „200 m“ bleibt zusammen
    return;
  }
  showRideSummary(saveRide({ ...summary, source, title }));
}

/** Starten mit einem Tipp, Beenden erst beim zweiten – gegen versehentliches Stoppen während der Fahrt. */
function onRecordTap() {
  const button = $('btn-record');
  if (!recording) {
    startRecording('manual', 'Aufnahme');
    return;
  }
  if (button.classList.contains('is-confirm')) {
    finishRecording();
    return;
  }
  button.classList.add('is-confirm');
  renderRecordButton();
  setTimeout(() => {
    button.classList.remove('is-confirm');
    renderRecordButton();
  }, 3000);
}

function renderRecordButton() {
  const button = $('btn-record');
  button.hidden = !state.mode;
  button.classList.toggle('is-recording', Boolean(recording));
  if (!recording) {
    if (button.dataset.view !== 'idle') {
      button.dataset.view = 'idle';
      button.innerHTML = '<span class="rec-dot"></span>';
      button.setAttribute('aria-label', 'Aufnahme starten');
    }
    return;
  }
  if (button.classList.contains('is-confirm')) {
    button.dataset.view = 'confirm';
    button.innerHTML = '<span class="rec-label">Stoppen?</span>';
    button.setAttribute('aria-label', 'Aufnahme beenden');
    return;
  }
  if (button.dataset.view !== 'recording') {
    button.dataset.view = 'recording';
    button.innerHTML = '<span class="rec-dot"></span><span class="rec-time"></span>';
    button.setAttribute('aria-label', 'Aufnahme läuft – zweimal tippen zum Beenden');
  }
  button.querySelector('.rec-time').textContent = formatStopwatch((Date.now() - recording.stats.startedAt) / 1000);
}

function formatStopwatch(totalSeconds) {
  const seconds = Math.floor(totalSeconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function renderRideSetting() {
  const rides = loadRides();
  $('ride-end').hidden = state.mode !== 'live'; // Demo hat ihren eigenen Knopf
  $('ride-log').hidden = !rides.length;
  $('ride-log').textContent = `Fahrtenbuch (${rides.length})`;
  if (recording) {
    const current = recording.stats.summary();
    $('ride-hint').textContent = `Aufnahme läuft: ${formatDistance(current.meters)} · ${formatStopwatch(current.totalSeconds)}`;
  } else {
    $('ride-hint').textContent = 'Aufnahmen startest du mit dem roten ● auf der Karte. Routen werden automatisch aufgenommen.';
  }
}

const rideDateFormat = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: '2-digit' });
const rideShortDateFormat = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });

function rideTimeRange(ride) {
  return `${rideDateFormat.format(new Date(ride.startedAt))} · ${clockFormat.format(new Date(ride.startedAt))}–${clockFormat.format(new Date(ride.endedAt))}`;
}

function showRideSummary(ride) {
  if (!ride) return;
  summaryRide = ride;
  $('summary-title').textContent = ride.title ?? 'Deine Fahrt';
  $('sum-date').textContent = rideTimeRange(ride);
  $('sum-distance').textContent = formatDistance(ride.meters);
  $('sum-moving').textContent = formatDuration(ride.movingSeconds);
  $('sum-total').textContent = formatDuration(ride.totalSeconds);
  $('sum-avg').textContent = ride.avgKmh ? `${Math.round(ride.avgKmh)} km/h` : '–';
  $('sum-max').textContent = `${Math.round(ride.maxKmh)} km/h`;
  $('sum-climb').textContent = `${ride.climbMeters.toLocaleString('de-DE')} m`;
  $('sum-lean-left').textContent = `${ride.maxLeanLeft}°`;
  $('sum-lean-right').textContent = `${ride.maxLeanRight}°`;
  $('summary-delete').classList.remove('is-confirm');
  $('summary-delete').textContent = 'Aufnahme löschen';
  $('lean-needle-left').style.transform = 'rotate(0deg)';
  $('lean-needle-right').style.transform = 'rotate(0deg)';
  $('sum-map-wrap').hidden = !(ride.track?.length > 1);
  $('ride-summary').hidden = false;
  $('ride-summary').scrollTop = 0;

  // Erst nach dem Einblenden: Zeiger drehen und Karte in der jetzt sichtbaren Fläche aufbauen.
  requestAnimationFrame(() => {
    $('lean-needle-left').style.transform = `rotate(${-ride.maxLeanLeft}deg)`;
    $('lean-needle-right').style.transform = `rotate(${ride.maxLeanRight}deg)`;
    renderSummaryMap(ride);
  });
}

/** Gefahrene Strecke auf einer kleinen Karte, farbig nach Tempo. */
function renderSummaryMap(ride) {
  summaryMap?.remove();
  summaryMap = null;
  if (!(ride.track?.length > 1)) return;

  const { lines, ends, bounds } = trackGeoJSON(ride.track);
  const style = buildStyle(settings.theme);
  style.sources.track = { type: 'geojson', data: lines };
  style.sources.trackEnds = { type: 'geojson', data: ends };
  style.layers.push(
    {
      id: 'track-casing',
      type: 'line',
      source: 'track',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#0b0d10', 'line-width': 8, 'line-opacity': 0.6 },
    },
    {
      id: 'track-line',
      type: 'line',
      source: 'track',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['interpolate', ['linear'], ['get', 'kmh'], ...TRACK_SPEED_COLORS], 'line-width': 5 },
    },
    {
      id: 'track-ends',
      type: 'circle',
      source: 'trackEnds',
      paint: {
        'circle-radius': 7,
        'circle-color': ['match', ['get', 'kind'], 'start', '#3ddc84', '#ff3b3b'],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2.5,
      },
    },
  );

  try {
    summaryMap = new maplibregl.Map({
      container: 'sum-map',
      style,
      bounds,
      fitBoundsOptions: { padding: 28, maxZoom: 15 },
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
    });
    summaryMap.touchZoomRotate.disableRotation();
    // Quellenangabe gleich zum (i) einklappen, sonst liegt sie über dem Endpunkt.
    summaryMap.once('load', () => {
      const attribution = $('sum-map').querySelector('.maplibregl-ctrl-attrib.maplibregl-compact');
      attribution?.classList.remove('maplibregl-compact-show');
      attribution?.removeAttribute('open');
    });
  } catch {
    $('sum-map-wrap').hidden = true; // ohne WebGL einfach ohne Karte
  }
}

/** Aus dem Fahrtenbuch heraus: Liste zur Seite legen, damit die Auswertung frei liegt. */
function openRideFromLog(ride) {
  cameFromRideLog = true;
  $('rides-sheet').hidden = true;
  showRideSummary(ride);
}

function closeRideSummary() {
  $('ride-summary').hidden = true;
  summaryMap?.remove(); // Grafikspeicher freigeben
  summaryMap = null;
  summaryRide = null;
  if (!cameFromRideLog) return;
  cameFromRideLog = false;
  openRideLog(); // zurück zur Liste – neu aufgebaut, falls eine Aufnahme gelöscht wurde
}

/** Löschen erst beim zweiten Tippen. */
function onDeleteRideTap() {
  const button = $('summary-delete');
  if (!summaryRide) return;
  if (!button.classList.contains('is-confirm')) {
    button.classList.add('is-confirm');
    button.textContent = 'Wirklich löschen?';
    setTimeout(() => {
      button.classList.remove('is-confirm');
      button.textContent = 'Aufnahme löschen';
    }, 3000);
    return;
  }
  deleteRide(summaryRide.id);
  closeRideSummary(); // zeigt das Fahrtenbuch wieder, falls es von dort kam
}

function openRideLog() {
  renderRideLog();
  $('rides-sheet').hidden = false;
}

function renderRideLog() {
  const rides = loadRides();
  $('rides-empty').hidden = rides.length > 0;
  $('rides-list').replaceChildren(
    ...rides.map((ride) => {
      const row = document.createElement('li');
      const button = document.createElement('button');
      button.className = 'ride-row';
      button.innerHTML =
        '<span class="ride-icon"></span><span class="row-text"><span class="row-title"></span><span class="row-sub"></span></span><span class="ride-km"></span>';
      button.querySelector('.ride-icon').innerHTML = ride.source === 'route' ? ICONS.route : '<span class="rec-dot"></span>';
      button.querySelector('.row-title').textContent = ride.title ?? 'Fahrt';
      const started = new Date(ride.startedAt);
      button.querySelector('.row-sub').textContent =
        `${rideShortDateFormat.format(started)} · ${clockFormat.format(started)} · ${formatDuration(ride.movingSeconds)}`;
      button.querySelector('.ride-km').textContent = formatDistance(ride.meters);
      button.addEventListener('click', () => openRideFromLog(ride));
      row.append(button);
      return row;
    }),
  );
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
    plan: { mode: 'dest', unit: 'km', km: 100, hours: 2, direction: null },
    voiceMuted: false,
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
