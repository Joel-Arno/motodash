// Routenberechnung über Valhalla (FOSSGIS-Server, kostenlos, mit Motorrad-Profil)
// und Fortschritt entlang einer aktiven Route.

import { distance } from './geo.js?v=1.2';

const VALHALLA_URL = 'https://valhalla1.openstreetmap.de/route';

/**
 * @param {{lng:number, lat:number}[]} points Start, Zwischenziele, Ziel
 * @param {{avoidHighways?:boolean, avoidTolls?:boolean, avoidFerries?:boolean}} options
 * @returns {Promise<Route[]>} beste Route zuerst, bei nur zwei Punkten bis zu zwei Alternativen
 */
export async function fetchRoutes(points, options = {}) {
  const motorcycle = {};
  if (options.avoidHighways) motorcycle.use_highways = 0;
  if (options.avoidTolls) motorcycle.use_tolls = 0;
  if (options.avoidFerries) motorcycle.use_ferry = 0;

  const request = {
    locations: points.map((p) => ({ lat: p.lat, lon: p.lng })),
    costing: 'motorcycle',
    costing_options: { motorcycle },
    // Alternativen berechnet Valhalla nur ohne Zwischenziele.
    alternates: points.length === 2 ? 2 : 0,
    language: 'de-DE',
    units: 'kilometers',
  };

  let response;
  try {
    response = await fetch(`${VALHALLA_URL}?json=${encodeURIComponent(JSON.stringify(request))}`);
  } catch {
    throw new Error('Keine Verbindung zum Routen-Dienst. Hast du Internet?');
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.trip) throw new Error(routingErrorMessage(data, response.status));

  return [data.trip, ...(data.alternates ?? []).map((alt) => alt.trip)].map(toRoute);
}

function toRoute(trip) {
  const coords = [];
  for (const leg of trip.legs) {
    const legCoords = decodePolyline(leg.shape);
    // Der erste Punkt eines Abschnitts ist der letzte des vorherigen.
    coords.push(...(coords.length ? legCoords.slice(1) : legCoords));
  }
  return {
    coords,
    lengthMeters: trip.summary.length * 1000,
    timeSeconds: trip.summary.time,
    hasHighway: Boolean(trip.summary.has_highway),
    hasToll: Boolean(trip.summary.has_toll),
    hasFerry: Boolean(trip.summary.has_ferry),
    legs: trip.legs, // enthält die Abbiegehinweise – für die Navigation (Schritt 3)
  };
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

/** Wie weit ist es noch? Projiziert die aktuelle Position auf die Route. */
export class RouteProgress {
  constructor(route) {
    this.route = route;
    this.coords = route.coords;
    this.cumulative = [0];
    for (let i = 1; i < this.coords.length; i++) {
      this.cumulative.push(this.cumulative[i - 1] + distance(this.coords[i - 1], this.coords[i]));
    }
    this.total = this.cumulative.at(-1) || 1;
  }

  update(lng, lat) {
    const metersPerLng = 111320 * Math.cos((lat * Math.PI) / 180);
    const metersPerLat = 110540;
    let bestDistance = Infinity;
    let bestAlong = 0;

    for (let i = 0; i < this.coords.length - 1; i++) {
      const [x1, y1] = this.coords[i];
      const [x2, y2] = this.coords[i + 1];
      // In Metern rund um die aktuelle Position rechnen (für kurze Abschnitte genau genug).
      const ax = (x1 - lng) * metersPerLng;
      const ay = (y1 - lat) * metersPerLat;
      const bx = (x2 - lng) * metersPerLng;
      const by = (y2 - lat) * metersPerLat;
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSq = dx * dx + dy * dy;
      const t = lengthSq > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / lengthSq)) : 0;
      const px = ax + dx * t;
      const py = ay + dy * t;
      const d = Math.hypot(px, py);
      if (d < bestDistance) {
        bestDistance = d;
        bestAlong = this.cumulative[i] + (this.cumulative[i + 1] - this.cumulative[i]) * t;
      }
    }

    const remainingMeters = Math.max(0, this.total - bestAlong);
    return {
      remainingMeters,
      remainingSeconds: this.route.timeSeconds * (remainingMeters / this.total),
      offRouteMeters: bestDistance,
    };
  }
}
