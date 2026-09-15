// Spotify-Wiedergabe steuern (Spotify Premium nötig).
// Anmeldung per „Authorization Code mit PKCE“ – funktioniert ohne eigenen Server und ohne geheimen Schlüssel.

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_URL = 'https://api.spotify.com/v1';
const SCOPES = 'user-read-playback-state user-modify-playback-state';
const STORE_KEY = 'motodash.spotify';

// Client-ID der eigenen Spotify-App (developer.spotify.com). Leer = in den Einstellungen eintragen.
const DEFAULT_CLIENT_ID = '';

export class SpotifyError extends Error {
  /** @param {'not-connected'|'auth'|'premium'|'no-device'|'no-volume'|'restricted'|'rate-limit'|'network'|'http'} code */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

let store = loadStore();

export const redirectUri = () => `${location.origin}${location.pathname}`;
export const getClientId = () => store.clientId || DEFAULT_CLIENT_ID;
export const isConnected = () => Boolean(store.refreshToken);

export function setClientId(clientId) {
  store = { ...store, clientId: clientId.trim() };
  saveStore();
}

export function disconnect() {
  store = { clientId: store.clientId };
  saveStore();
}

/** Zur Spotify-Anmeldung weiterleiten. Danach kommt Spotify mit ?code=… zur App zurück. */
export async function connect() {
  const clientId = getClientId();
  if (!clientId) throw new SpotifyError('auth', 'Bitte zuerst die Client-ID eintragen.');

  const verifier = randomString(64);
  const challenge = base64Url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const authState = randomString(16);
  store = { ...store, verifier, authState };
  saveStore();

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: challenge,
    scope: SCOPES,
    state: authState,
  });
  location.assign(`${AUTH_URL}?${params}`);
}

/**
 * Beim App-Start aufrufen: Kommt die App gerade von der Spotify-Anmeldung zurück?
 * @returns {Promise<null | {ok: boolean, message: string}>}
 */
export async function handleRedirect() {
  const url = new URL(location.href);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (!code && !error) return null;

  history.replaceState(null, '', redirectUri()); // ?code=… aus der Adresse entfernen
  if (error) return { ok: false, message: error === 'access_denied' ? 'Verbindung abgebrochen.' : `Spotify meldet: ${error}` };
  if (url.searchParams.get('state') !== store.authState) return { ok: false, message: 'Anmeldung ungültig – bitte nochmal verbinden.' };

  try {
    await requestTokens({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      client_id: getClientId(),
      code_verifier: store.verifier,
    });
    return { ok: true, message: 'Mit Spotify verbunden.' };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

// ---------- Wiedergabe ----------

/** Aktuelle Wiedergabe oder null (nichts aktiv / kein Gerät). */
export async function getPlayback() {
  const data = await api('GET', '/me/player?additional_types=episode');
  if (!data?.item) return null;
  const { item } = data;
  const images = item.album?.images ?? item.images ?? [];
  const cover = images.find((image) => image.width && image.width <= 320) ?? images[0];
  return {
    fetchedAt: Date.now(),
    isPlaying: Boolean(data.is_playing),
    title: item.name,
    artist: (item.artists ?? []).map((artist) => artist.name).join(', ') || item.show?.name || '',
    cover: cover?.url ?? null,
    trackUri: item.uri,
    contextUri: data.context?.uri ?? null,
    progressMs: data.progress_ms ?? 0,
    deviceId: data.device?.id ?? null,
    volume: data.device?.volume_percent ?? null,
    supportsVolume: Boolean(data.device?.supports_volume),
    repeatState: data.repeat_state ?? 'off',
  };
}

const withDevice = (path, deviceId) =>
  deviceId ? `${path}${path.includes('?') ? '&' : '?'}device_id=${encodeURIComponent(deviceId)}` : path;

/** @param deviceId optional: gezielt dieses Gerät ansprechen (weckt ein eingeschlafenes Spotify eher auf) */
export const play = (deviceId) => api('PUT', withDevice('/me/player/play', deviceId));
export const pause = () => api('PUT', '/me/player/pause');
export const nextTrack = () => api('POST', '/me/player/next');
export const previousTrack = () => api('POST', '/me/player/previous');
export const setVolume = (percent, deviceId) =>
  api('PUT', withDevice(`/me/player/volume?volume_percent=${Math.round(percent)}`, deviceId));
export const setRepeat = (repeatState, deviceId) =>
  api('PUT', withDevice(`/me/player/repeat?state=${encodeURIComponent(repeatState)}`, deviceId));
export const playUris = (uris, deviceId) => api('PUT', withDevice('/me/player/play', deviceId), { body: { uris } });
export const seek = (positionMs, deviceId) =>
  api('PUT', withDevice(`/me/player/seek?position_ms=${Math.max(0, Math.round(positionMs))}`, deviceId));

/** Einen bestimmten Titel an einer Stelle starten – wenn möglich innerhalb seiner Playlist/seines Albums. */
export async function playAt({ trackUri, contextUri, positionMs, deviceId }) {
  const path = withDevice('/me/player/play', deviceId);
  const position_ms = Math.max(0, Math.round(positionMs));
  if (contextUri) {
    try {
      return await api('PUT', path, { body: { context_uri: contextUri, offset: { uri: trackUri }, position_ms } });
    } catch (err) {
      if (err.code === 'network' || err.code === 'no-device') throw err;
      // Manche Listen (z. B. „Lieblingssongs“) lassen sich so nicht starten – dann nur den Titel.
    }
  }
  return api('PUT', path, { body: { uris: [trackUri], position_ms } });
}

async function api(method, path, { body } = {}, retry = true) {
  const token = await accessToken();
  let response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body && { 'Content-Type': 'application/json' }) },
      ...(body && { body: JSON.stringify(body) }),
    });
  } catch {
    throw new SpotifyError('network', 'Keine Verbindung zu Spotify.');
  }

  if (response.status === 401 && retry) {
    store.expiresAt = 0; // Token abgelaufen – erneuern und nochmal
    return api(method, path, { body }, false);
  }
  const text = await response.text();
  const data = parseJson(text);

  if (response.status === 204) return null; // nichts spielt
  if (response.status === 404) {
    if (method === 'GET') return null;
    throw new SpotifyError('no-device', 'Spotify ist gerade nicht aktiv.');
  }
  if (response.status === 403) {
    if (data?.error?.reason === 'PREMIUM_REQUIRED') throw new SpotifyError('premium', 'Spotify erlaubt das nur mit Premium.');
    if (data?.error?.reason === 'VOLUME_CONTROL_DISALLOW') throw new SpotifyError('no-volume', 'Lautstärke lässt sich nicht steuern.');
    // z. B. „schon pausiert“ oder „kein vorheriger Titel“ – kein echter Fehler
    throw new SpotifyError('restricted', data?.error?.message ?? 'Spotify lässt das gerade nicht zu.');
  }
  if (response.status === 429) throw new SpotifyError('rate-limit', 'Zu viele Anfragen an Spotify.');
  if (!response.ok) throw new SpotifyError('http', `Spotify-Fehler ${response.status}.`);
  return data;
}

/** Steuerbefehle schicken teils nur eine Kennung als Text zurück statt JSON – das ist kein Fehler. */
function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------- Anmeldung ----------

async function accessToken() {
  if (store.accessToken && Date.now() < store.expiresAt) return store.accessToken;
  if (!store.refreshToken) throw new SpotifyError('not-connected', 'Nicht mit Spotify verbunden.');
  await requestTokens({ grant_type: 'refresh_token', refresh_token: store.refreshToken, client_id: getClientId() });
  return store.accessToken;
}

async function requestTokens(body) {
  let response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
  } catch {
    throw new SpotifyError('network', 'Keine Verbindung zu Spotify.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (data.error === 'invalid_grant' && body.grant_type === 'refresh_token') disconnect();
    throw new SpotifyError('auth', `Spotify-Anmeldung fehlgeschlagen${data.error_description ? `: ${data.error_description}` : '.'}`);
  }
  store = {
    clientId: store.clientId,
    accessToken: data.access_token,
    // Spotify schickt manchmal einen neuen Refresh-Token mit – sonst den alten behalten.
    refreshToken: data.refresh_token ?? store.refreshToken,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  saveStore();
}

function randomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values, (v) => chars[v % chars.length]).join('');
}

function base64Url(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function loadStore() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function saveStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    // Ohne Speicher bleibt die Verbindung nur bis zum Neuladen bestehen.
  }
}
