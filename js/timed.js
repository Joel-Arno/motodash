// Route mit Wunsch-Ankunft: Ist mehr Zeit da als nötig, wird ein Umweg eingebaut,
// damit man später ankommt statt zu warten. Reicht die Zeit nicht, bleibt es bei der schnellsten Route.

import { fetchRoutes } from './routing.js?v=2.1';

const TOLERANCE = 0.12; // ±12 % gilt als getroffen
const MAX_ATTEMPTS = 3;
const PAUSE_MS = 350;
const MIN_EXTRA = 1.12; // darunter lohnt kein Umweg
const MAX_EXTRA = 5; // mehr als fünffache Fahrzeit planen wir nicht

/**
 * @param {{lng:number, lat:number}[]} points Start, Zwischenziele, Ziel
 * @param {object} options Routen-Optionen
 * @param {number} targetSeconds gewünschte Fahrzeit bis zur Ankunft
 * @param {(done:number, total:number) => void} [onProgress]
 * @returns {Promise<{routes: object[], stretched: boolean, tooShort: boolean}>}
 */
export async function findTimedRoutes(points, options, targetSeconds, onProgress) {
  const fastest = await fetchRoutes(points, options);
  const quickest = fastest[0];
  const wanted = Math.min(targetSeconds, quickest.timeSeconds * MAX_EXTRA);

  // Zeit zu knapp oder kaum Luft: schnellste Route nehmen.
  if (!(wanted > quickest.timeSeconds * MIN_EXTRA)) {
    return { routes: fastest, stretched: false, tooShort: targetSeconds < quickest.timeSeconds };
  }

  const origin = points[0];
  const destination = points.at(-1);
  const side = Math.random() < 0.5 ? 90 : -90;
  let detourKm = (quickest.lengthMeters / 1000) * (wanted / quickest.timeSeconds - 1) * 0.45;
  let best = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    onProgress?.(attempt + 1, MAX_ATTEMPTS);
    const via = sidePoint(origin, destination, detourKm, side + attempt * 15);
    let route;
    try {
      [route] = await fetchRoutes([...points.slice(0, -1), { ...via, via: true }, destination], options);
    } catch {
      break; // Umweg nicht fahrbar – dann bleibt die schnellste Route
    }
    const ratio = route.timeSeconds / wanted;
    if (!best || Math.abs(ratio - 1) < Math.abs(best.ratio - 1)) best = { route, ratio };
    if (Math.abs(ratio - 1) <= TOLERANCE) break;

    detourKm /= Math.min(2.5, Math.max(0.4, ratio)); // zu lang → kleinerer Umweg, zu kurz → größerer
    await sleep(PAUSE_MS);
  }

  if (!best) return { routes: fastest, stretched: false, tooShort: false };
  // Die schnellste Route bleibt als Alternative wählbar.
  return { routes: [best.route, quickest], stretched: true, tooShort: false };
}

/** Punkt neben der Luftlinie zwischen Start und Ziel – dort geht es auf dem Umweg entlang. */
function sidePoint(a, b, km, bearingOffset) {
  const middle = { lng: (a.lng + b.lng) / 2, lat: (a.lat + b.lat) / 2 };
  return offsetPoint(middle, courseBetween(a, b) + bearingOffset, Math.max(1, km));
}

function courseBetween(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function offsetPoint({ lng, lat }, bearingDeg, km) {
  const d = km / 6371;
  const b = (bearingDeg * Math.PI) / 180;
  const lat1 = (lat * Math.PI) / 180;
  const lng1 = (lng * Math.PI) / 180;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lng2 = lng1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lng: (lng2 * 180) / Math.PI, lat: (lat2 * 180) / Math.PI };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
