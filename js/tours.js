// Rundtouren: Start = Ziel, gewünschte Länge in km oder Zeit.
// Der Routen-Dienst kann keine Rundtouren – deshalb legen wir unsichtbare Wegpunkte auf einen Kreis,
// der durch den Start geht, lassen Valhalla die Route berechnen und passen die Kreisgröße bei Bedarf an.

import { fetchRoutes, nearestOnRoute } from './routing.js?v=2.1';

const START_ROAD_FACTOR = 1.35; // Straßen sind im Schnitt so viel länger als der Kreis
const TOLERANCE = 0.15; // ±15 % gilt als getroffen, sonst nachjustieren
const MAX_ATTEMPTS = 4;
// Rückweg über dieselbe Straße: so viel Wiederholung ist gerade noch in Ordnung
const MAX_BACKTRACK = 0.08;
const BAD_BACKTRACK = 0.35; // darüber wird die Tour gar nicht erst vorgeschlagen
const BACKTRACK_WEIGHT = 1.5; // wie stark Wenden zählen
const LENGTH_WEIGHT = 2; // … und wie stark die gewünschte Länge
const SAMPLE_METERS = 150; // Abstand der Prüfpunkte auf der Route
const SAME_ROAD_METERS = 30; // so nah gilt als „dieselbe Straße“
const APART_METERS = 1200; // … aber nur, wenn die Stellen in der Fahrt weit auseinanderliegen
const ENDS_METERS = 400; // Anfang und Ende liegen bei Rundtouren zwangsläufig aufeinander
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
  // Touren, die größtenteils auf demselben Weg zurückführen, lieber weglassen – außer es bleibt nichts übrig.
  const good = tours.filter((tour) => tour.backtrack <= BAD_BACKTRACK);
  return good.length ? good : tours;
}

async function buildTour(origin, direction, estimateKm, target, byTime, options) {
  let factor = START_ROAD_FACTOR;
  let best = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Andere Anzahl Wegpunkte und ein kleiner Versatz je Versuch – hilft gegen Sackgassen,
    // in die man nur hinein- und wieder herausfährt. Ab dem zweiten Versuch dürfen die Wegpunkte
    // nur noch auf größeren Straßen liegen; kleine Stichstraßen sind die häufigste Wende-Ursache.
    const roadClass = attempt === 0 ? 'tertiary' : 'secondary';
    const waypoints = circleWaypoints(origin, direction + attempt * 18, estimateKm / factor, 4 + (attempt % 2));
    const [route] = await fetchRoutes(
      [origin, ...waypoints.map((p) => ({ ...p, via: true, roadClass })), origin],
      options,
    );
    const measured = byTime ? route.timeSeconds : route.lengthMeters / 1000;
    const ratio = measured / target;
    const backtrack = backtrackFraction(route);
    const score = Math.abs(ratio - 1) * LENGTH_WEIGHT + backtrack * BACKTRACK_WEIGHT;

    if (!best || score < best.score) best = { route, ratio, backtrack, score };
    if (Math.abs(ratio - 1) <= TOLERANCE && backtrack <= MAX_BACKTRACK) break;

    if (Math.abs(ratio - 1) > TOLERANCE) factor *= ratio; // zu lang → Kreis kleiner, zu kurz → größer
    await sleep(PAUSE_MS);
  }

  return {
    ...best.route,
    directionLabel: COMPASS[Math.round(normalize(direction) / 45) % 8],
    backtrack: best.backtrack,
  };
}

/**
 * Wie viel der Tour auf derselben Straße zurückgefahren wird (0 = gar nicht, 1 = alles).
 * Dafür wird die Route abgetastet: Punkte, die räumlich fast gleich sind, in der Fahrt aber
 * weit auseinanderliegen, zählen als Rückweg.
 */
export function backtrackFraction(route) {
  const total = route.cumulative.at(-1);
  if (!total || total < 4 * ENDS_METERS) return 0;

  let samples = 0;
  let repeated = 0;
  for (let at = ENDS_METERS; at <= total - ENDS_METERS; at += SAMPLE_METERS) {
    const [lng, lat] = pointAt(route.coords, route.cumulative, at);
    samples++;
    // Nächster Punkt der Route, der in der Fahrt weit vorher oder weit nachher liegt.
    const before = nearestOnRoute(route, lng, lat, ENDS_METERS, at - APART_METERS);
    const after = nearestOnRoute(route, lng, lat, at + APART_METERS, total - ENDS_METERS);
    if (Math.min(before.distance, after.distance) <= SAME_ROAD_METERS) repeated++;
  }
  return samples ? repeated / samples : 0;
}

function pointAt(coords, cumulative, meters) {
  let i = 0;
  while (i < cumulative.length - 2 && cumulative[i + 1] < meters) i++;
  const segment = cumulative[i + 1] - cumulative[i];
  const t = segment > 0 ? (meters - cumulative[i]) / segment : 0;
  return [coords[i][0] + (coords[i + 1][0] - coords[i][0]) * t, coords[i][1] + (coords[i + 1][1] - coords[i][1]) * t];
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
