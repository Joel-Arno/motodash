// Routenberechnung über Valhalla (FOSSGIS-Server, kostenlos, mit Motorrad-Profil),
// Fortschritt entlang einer aktiven Route und Tempolimits.

import { distance } from './geo.js?v=1.2.1';

const VALHALLA_URL = 'https://valhalla1.openstreetmap.de';

// Valhalla-Manövertypen, die keine Fahranweisung sind: Straße heißt anders, geradeaus weiter,
// Ausfahrt aus dem Kreisverkehr (steckt schon in „2. Ausfahrt nehmen“).
const SILENT_MANEUVER_TYPES = new Set([7, 8, 27]);

/**
 * @param {{lng:number, lat:number, via?:boolean}[]} points Start, Zwischenziele, Ziel.
 *   `via` = unsichtbarer Wegpunkt, durch den nur hindurchgefahren wird (für Rundtouren).
 * @param {{avoidHighways?:boolean, avoidTolls?:boolean, avoidFerries?:boolean,
 *   blocked?:{lng:number, lat:number}[]}} options
 *   `blocked` = Stellen, die gemieden werden sollen (gesperrte Straße)
 * @returns {Promise<Route[]>} beste Route zuerst, bei nur zwei Punkten bis zu zwei Alternativen
 */
export async function fetchRoutes(points, options = {}) {
  const motorcycle = {};
  if (options.avoidHighways) motorcycle.use_highways = 0;
  if (options.avoidTolls) motorcycle.use_tolls = 0;
  if (options.avoidFerries) motorcycle.use_ferry = 0;

  const request = {
    locations: points.map((p) =>
      p.via
        ? // Nur an richtige Straßen andocken, nicht an Feld- oder Waldwege.
          { lat: p.lat, lon: p.lng, type: 'through', search_filter: { min_road_class: p.roadClass ?? 'tertiary' } }
        : { lat: p.lat, lon: p.lng },
    ),
    costing: 'motorcycle',
    costing_options: { motorcycle },
    // Alternativen berechnet Valhalla nur ohne Zwischenziele.
    alternates: points.length === 2 ? 2 : 0,
    language: 'de-DE',
    units: 'kilometers',
    ...(options.blocked?.length && {
      exclude_locations: options.blocked.map((p) => ({ lat: p.lat, lon: p.lng })),
    }),
  };

  let response;
  try {
    response = await fetch(`${VALHALLA_URL}/route?json=${encodeURIComponent(JSON.stringify(request))}`);
  } catch {
    throw new Error('Keine Verbindung zum Routen-Dienst. Hast du Internet?');
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.trip) throw new Error(routingErrorMessage(data, response.status));

  return [data.trip, ...(data.alternates ?? []).map((alt) => alt.trip)].map((trip) =>
    toRoute(trip, points.slice(1), options),
  );
}

function toRoute(trip, targets, options) {
  const coords = [];
  const maneuvers = [];

  trip.legs.forEach((leg, legIndex) => {
    const legCoords = decodePolyline(leg.shape);
    // Der erste Punkt eines Abschnitts ist der letzte des vorherigen.
    const offset = coords.length ? coords.length - 1 : 0;
    coords.push(...(coords.length ? legCoords.slice(1) : legCoords));
    const isLastLeg = legIndex === trip.legs.length - 1;

    for (const m of leg.maneuvers) {
      const isStart = m.type >= 1 && m.type <= 3;
      const isArrival = m.type >= 4 && m.type <= 6;
      if (SILENT_MANEUVER_TYPES.has(m.type)) continue;
      if (isStart && legIndex > 0) continue; // Weiterfahrt nach einem Zwischenziel

      maneuvers.push({
        type: m.type,
        kind: isStart ? 'start' : isArrival ? (isLastLeg ? 'destination' : 'waypoint') : 'turn',
        instruction: m.instruction,
        alert: m.verbal_transition_alert_instruction || m.verbal_pre_transition_instruction || m.instruction,
        now: m.verbal_pre_transition_instruction || m.instruction,
        after: m.verbal_post_transition_instruction || '',
        streets: m.street_names ?? [],
        exitCount: m.roundabout_exit_count ?? 0,
        shapeIndex: offset + m.begin_shape_index,
      });
    }
  });

  const cumulative = [0];
  for (let i = 1; i < coords.length; i++) cumulative.push(cumulative[i - 1] + distance(coords[i - 1], coords[i]));
  for (const m of maneuvers) m.along = cumulative[Math.min(m.shapeIndex, cumulative.length - 1)];

  const route = {
    coords,
    cumulative,
    shapeMeters: cumulative.at(-1) || 1,
    lengthMeters: trip.summary.length * 1000,
    timeSeconds: trip.summary.time,
    hasHighway: Boolean(trip.summary.has_highway),
    hasToll: Boolean(trip.summary.has_toll),
    hasFerry: Boolean(trip.summary.has_ferry),
    maneuvers,
    options,
    speedLimits: null,
  };

  // Wo liegen Zwischenziele/Wegpunkte auf der Route? Wird fürs Neuberechnen gebraucht.
  let from = 0;
  route.waypoints = targets.map((p, i) => {
    const along = i === targets.length - 1 ? route.shapeMeters : nearestOnRoute(route, p.lng, p.lat, from).along;
    from = along;
    return { lng: p.lng, lat: p.lat, via: Boolean(p.via), along };
  });

  return route;
}

function routingErrorMessage(data, status) {
  switch (data.error_code) {
    case 442:
    case 443:
      return 'Für diese Strecke wurde keine Route gefunden.';
    case 154:
      return 'Die Strecke ist zu lang für den kostenlosen Routen-Dienst.';
    case 171:
      return 'Ein Punkt liegt zu weit von einer Straße entfernt.';
  }
  if (status === 429) return 'Zu viele Anfragen – bitte kurz warten und nochmal versuchen.';
  return `Routenberechnung fehlgeschlagen${data.error ? `: ${data.error}` : ` (Fehler ${status})`}.`;
}

// ---------- Tempolimits ----------

const LIMIT_CHUNK_METERS = 150000; // der Dienst prüft höchstens ~200 km am Stück

/**
 * Tempolimits (km/h) je Routenabschnitt: result[i] gilt zwischen coords[i] und coords[i+1], 0 = unbekannt.
 * Quelle sind die OpenStreetMap-Daten – nicht überall eingetragen.
 */
export async function fetchSpeedLimits(route) {
  const limits = new Uint16Array(Math.max(0, route.coords.length - 1));

  // An Zwischenzielen wendet die Route oft – dort getrennt abfragen, sonst schlägt die Zuordnung fehl.
  const cuts = new Set(route.maneuvers.filter((m) => m.kind === 'waypoint').map((m) => m.shapeIndex));
  let start = 0;
  while (start < route.coords.length - 1) {
    let end = start + 1;
    while (
      end < route.coords.length - 1 &&
      !cuts.has(end) &&
      route.cumulative[end] - route.cumulative[start] < LIMIT_CHUNK_METERS
    ) {
      end++;
    }
    const edges = await traceEdges(route.coords.slice(start, end + 1));
    for (const edge of edges) {
      // Sehr hohe Werte stehen für „kein Limit“ (z. B. Autobahn) – dann kein Schild zeigen.
      const limit = edge.speed_limit > 0 && edge.speed_limit < 200 ? edge.speed_limit : 0;
      for (let i = start + edge.begin_shape_index; i < start + edge.end_shape_index && i < limits.length; i++) {
        limits[i] = limit;
      }
    }
    start = end;
  }
  return limits;
}

/** Straßenabschnitte zu einer Linie – erst exakt, sonst ungefähr zugeordnet. */
async function traceEdges(coords) {
  for (const shapeMatch of ['edge_walk', 'map_snap']) {
    const response = await fetch(`${VALHALLA_URL}/trace_attributes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        encoded_polyline: encodePolyline(coords),
        shape_match: shapeMatch,
        costing: 'motorcycle',
        filters: { attributes: ['edge.speed_limit', 'edge.begin_shape_index', 'edge.end_shape_index'], action: 'include' },
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data.edges) return data.edges;
  }
  return []; // Tempolimits für diesen Teil unbekannt
}

// ---------- Polyline ----------

/** Valhalla-Polyline (6 Nachkommastellen) → [[lng, lat], …] */
export function decodePolyline(encoded, precision = 6) {
  const factor = 10 ** precision;
  const coords = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    for (let axis = 0; axis < 2; axis++) {
      let result = 0;
      let shift = 0;
      let byte;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lng += delta;
    }
    coords.push([lng / factor, lat / factor]);
  }
  return coords;
}

/** [[lng, lat], …] → Valhalla-Polyline (6 Nachkommastellen) */
export function encodePolyline(coords, precision = 6) {
  const factor = 10 ** precision;
  let output = '';
  let prevLat = 0;
  let prevLng = 0;
  const encodeValue = (value) => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    while (v >= 0x20) {
      output += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    output += String.fromCharCode(v + 63);
  };
  for (const [lng, lat] of coords) {
    const latE = Math.round(lat * factor);
    const lngE = Math.round(lng * factor);
    encodeValue(latE - prevLat);
    encodeValue(lngE - prevLng);
    prevLat = latE;
    prevLng = lngE;
  }
  return output;
}

// ---------- Position auf der Route ----------

/**
 * Nächste Stelle der Route zu einem Punkt, optional nur im Bereich [minAlong, maxAlong] Meter.
 * @returns {{distance:number, along:number, index:number}}
 */
export function nearestOnRoute(route, lng, lat, minAlong = -Infinity, maxAlong = Infinity) {
  const { coords, cumulative } = route;
  const metersPerLng = 111320 * Math.cos((lat * Math.PI) / 180);
  const metersPerLat = 110540;
  const best = { distance: Infinity, along: 0, index: 0 };

  for (let i = 0; i < coords.length - 1; i++) {
    if (cumulative[i + 1] < minAlong || cumulative[i] > maxAlong) continue;
    // In Metern rund um den Punkt rechnen (für kurze Abschnitte genau genug).
    const ax = (coords[i][0] - lng) * metersPerLng;
    const ay = (coords[i][1] - lat) * metersPerLat;
    const dx = (coords[i + 1][0] - lng) * metersPerLng - ax;
    const dy = (coords[i + 1][1] - lat) * metersPerLat - ay;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / lengthSq)) : 0;
    const d = Math.hypot(ax + dx * t, ay + dy * t);
    if (d < best.distance) {
      best.distance = d;
      best.along = cumulative[i] + (cumulative[i + 1] - cumulative[i]) * t;
      best.index = i;
    }
  }
  return best;
}

const SEARCH_BEHIND_METERS = 300;
const SEARCH_AHEAD_METERS = 3000;
const JUMP_ADVANTAGE_METERS = 150; // so viel näher muss eine andere Stelle sein, damit wir dorthin springen

/**
 * Wie weit ist es noch? Projiziert die aktuelle Position auf die Route.
 * Gesucht wird zuerst nur rund um die zuletzt gefahrene Stelle – sonst würde bei Rundtouren
 * (Start = Ziel) schon beim Losfahren das Ende der Route als „nächste Stelle“ erkannt.
 */
export class RouteProgress {
  constructor(route) {
    this.route = route;
    this.total = route.shapeMeters;
    this.along = 0; // bisher gefahrene Meter auf der Route
  }

  update(lng, lat) {
    const nearby = nearestOnRoute(this.route, lng, lat, this.along - SEARCH_BEHIND_METERS, this.along + SEARCH_AHEAD_METERS);
    const anywhere = nearestOnRoute(this.route, lng, lat);

    // Nur springen, wenn eine andere Stelle deutlich näher ist (z. B. Abkürzung gefahren).
    // Ungenaues GPS am Start einer Rundtour springt so nicht ans Routen-Ende.
    const best = anywhere.distance < nearby.distance - JUMP_ADVANTAGE_METERS ? anywhere : nearby;
    this.along = best.along;

    const remainingMeters = Math.max(0, this.total - best.along);
    return {
      along: best.along,
      segmentIndex: best.index,
      remainingMeters,
      remainingSeconds: this.route.timeSeconds * (remainingMeters / this.total),
      offRouteMeters: best.distance,
    };
  }
}
