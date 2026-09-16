// Rundtouren: Start = Ziel, gewünschte Länge in km oder Zeit.
// Der Routen-Dienst kann keine Rundtouren – deshalb legen wir unsichtbare Wegpunkte auf einen Kreis,
// der durch den Start geht, lassen Valhalla die Route berechnen und passen die Kreisgröße bei Bedarf an.

import { fetchRoutes } from './routing.js?v=2.0';

const START_ROAD_FACTOR = 1.35; // Straßen sind im Schnitt so viel länger als der Kreis
const TOLERANCE = 0.15; // ±15 % gilt als getroffen, sonst nachjustieren
const MAX_ATTEMPTS = 3;
const PAUSE_MS = 350; // kurze Pause zwischen Anfragen – der kostenlose Dienst soll nicht überlastet werden
const AVG_KMH = { noHighway: 45, withHighway: 55 }; // Startschätzung für Touren nach Zeit

const COMPASS = ['Nord', 'Nordost', 'Ost', 'Südost', 'Süd', 'Südwest', 'West', 'Nordwest'];

/**
 * @param {{lng:number, lat:number}} origin Start und Ende
 * @param {{unit:'km'|'time', km:number, hours:number, direction:number|null}} spec
 * @param {object} options Routen-Optionen (Autobahn/Maut/Fähren)
 * @param {(done:number, total:number) => void} [onProgress]
 */
export async function findRoundTrips(origin, spec, options, onProgress) {
  const byTime = spec.unit === 'time';
  const target = byTime ? spec.hours * 3600 : spec.km;
  const estimateKm = byTime ? spec.hours * (options.avoidHighways ? AVG_KMH.noHighway : AVG_KMH.withHighway) : spec.km;

  const directions = pickDirections(spec.direction);
  const tours = [];
  let lastError = null;

  for (let i = 0; i < directions.length; i++) {
    onProgress?.(i + 1, directions.length);
    try {
      tours.push(await buildTour(origin, directions[i], estimateKm, target, byTime, options));
    } catch (err) {
      lastError = err;
    }
    await sleep(PAUSE_MS);
  }

  if (!tours.length) {
    throw new Error(lastError?.message ?? 'Hier konnte keine Rundtour gefunden werden. Versuch eine andere Länge.');
  }
  return tours;
}

async function buildTour(origin, direction, estimateKm, target, byTime, options) {
  const waypointCount = 3 + Math.floor(Math.random() * 3); // 3–5 Wegpunkte für mehr Abwechslung
  let factor = START_ROAD_FACTOR;
  let best = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const waypoints = circleWaypoints(origin, direction, estimateKm / factor, waypointCount);
    const [route] = await fetchRoutes([origin, ...waypoints.map((p) => ({ ...p, via: true })), origin], options);
    const measured = byTime ? route.timeSeconds : route.lengthMeters / 1000;
    const ratio = measured / target;

    if (!best || Math.abs(ratio - 1) < Math.abs(best.ratio - 1)) best = { route, ratio };
    if (Math.abs(ratio - 1) <= TOLERANCE) break;

    factor *= ratio; // zu lang → Kreis kleiner, zu kurz → Kreis größer
    await sleep(PAUSE_MS);
  }

  return { ...best.route, directionLabel: COMPASS[Math.round(normalize(direction) / 45) % 8] };
}

/** Bei „egal“ drei Richtungen gleichmäßig verteilt, sonst drei Varianten um die gewählte Richtung. */
function pickDirections(direction) {
  if (direction == null) {
    const base = Math.random() * 360;
    return [base, base + 120, base + 240];
  }
  const spread = 25 + Math.random() * 20;
  return [direction, direction - spread, direction + spread];
}

/** Punkte auf einem Kreis mit Umfang `loopKm`, der durch den Start geht und in `direction` liegt. */
function circleWaypoints(origin, direction, loopKm, count) {
  const radiusKm = loopKm / (2 * Math.PI);
  const center = offset(origin, direction, radiusKm);
  const points = [];
  for (let i = 1; i <= count; i++) {
    // Vom Mittelpunkt aus gesehen liegt der Start bei direction + 180°.
    points.push(offset(center, direction + 180 + (360 / (count + 1)) * i, radiusKm));
  }
  return points;
}

function offset({ lng, lat }, bearingDeg, km) {
  const d = km / 6371;
  const b = (bearingDeg * Math.PI) / 180;
  const lat1 = (lat * Math.PI) / 180;
  const lng1 = (lng * Math.PI) / 180;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lng2 = lng1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lng: (lng2 * 180) / Math.PI, lat: (lat2 * 180) / Math.PI };
}

const normalize = (deg) => ((deg % 360) + 360) % 360;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
