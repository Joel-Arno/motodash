// Fahrtenbuch: gespeicherte Aufnahmen (auf dem Gerät, im Browser-Speicher).

const RIDES_KEY = 'motodash.rides';
const LEGACY_LAST_RIDE_KEY = 'motodash.lastRide';
const MAX_RIDES = 50;

/** Alle Aufnahmen, neueste zuerst. */
export function loadRides() {
  try {
    const rides = JSON.parse(localStorage.getItem(RIDES_KEY));
    return Array.isArray(rides) ? rides : [];
  } catch {
    return [];
  }
}

/** Speichert eine Aufnahme und gibt sie (mit id) zurück. */
export function saveRide(ride) {
  const saved = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ...ride };
  const rides = [saved, ...loadRides()].slice(0, MAX_RIDES);
  writeRides(rides);
  return saved;
}

export function deleteRide(id) {
  writeRides(loadRides().filter((ride) => ride.id !== id));
}

/** Die frühere „letzte Fahrt“ (vor dem Fahrtenbuch) einmalig übernehmen. */
export function migrateLegacyRide() {
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_LAST_RIDE_KEY));
    if (legacy && !loadRides().length) saveRide({ ...legacy, source: 'manual', title: 'Fahrt', track: [] });
    localStorage.removeItem(LEGACY_LAST_RIDE_KEY);
  } catch {
    // nichts zu übernehmen
  }
}

/** Voller Speicher: bei den ältesten Fahrten zuerst die Linie weglassen (Zahlen bleiben). */
function writeRides(rides) {
  for (let attempt = rides.length; attempt >= 0; attempt--) {
    try {
      localStorage.setItem(RIDES_KEY, JSON.stringify(rides));
      return;
    } catch {
      const oldestWithTrack = rides.findLastIndex((ride) => ride.track?.length);
      if (oldestWithTrack < 0) return;
      rides[oldestWithTrack] = { ...rides[oldestWithTrack], track: [] };
    }
  }
}

/**
 * Linie für die Karte: Abschnitte mit Tempo (zum Einfärben), Start/Ziel-Punkte und Ausschnitt.
 * @param {[number, number, number][]} track [lng, lat, km/h]
 */
export function trackGeoJSON(track) {
  const features = [];
  for (let i = 1; i < track.length; i++) {
    const [lng1, lat1, kmh1] = track[i - 1];
    const [lng2, lat2, kmh2] = track[i];
    features.push({
      type: 'Feature',
      properties: { kmh: (kmh1 + kmh2) / 2 },
      geometry: { type: 'LineString', coordinates: [[lng1, lat1], [lng2, lat2]] },
    });
  }

  const lngs = track.map((p) => p[0]);
  const lats = track.map((p) => p[1]);
  const endpoint = (point, kind) => ({
    type: 'Feature',
    properties: { kind },
    geometry: { type: 'Point', coordinates: [point[0], point[1]] },
  });

  return {
    lines: { type: 'FeatureCollection', features },
    ends: { type: 'FeatureCollection', features: [endpoint(track[0], 'start'), endpoint(track.at(-1), 'end')] },
    bounds: [
      [Math.min(...lngs), Math.min(...lats)],
      [Math.max(...lngs), Math.max(...lats)],
    ],
  };
}
