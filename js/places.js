// Tankstellen, Cafés und Rastplätze – in der Nähe oder entlang der Route.
// Quelle ist wie bei der Zielsuche Photon (OpenStreetMap), hier über die Umkreissuche mit Kategorie.

import { fetchWithTimeout } from './net.js?v=2.3';
import { distance } from './geo.js?v=2.3';
import { nearestOnRoute } from './routing.js?v=2.3';

const PHOTON_URL = 'https://photon.komoot.io/reverse';
const NEARBY_RADIUS_KM = 10;
const ROUTE_AHEAD_METERS = 60000; // so weit voraus wird entlang der Route gesucht
const ROUTE_SAMPLES = 4; // an so vielen Stellen der Route wird nachgefragt – nacheinander, die nächste zuerst
const MAX_DETOUR_METERS = 2000; // weiter abseits der Route lohnt der Umweg nicht
const DETOUR_WEIGHT = 4; // ein Meter Umweg zählt wie vier Meter weiter voraus
const MAX_RESULTS = 8;
const RETRY_DELAY_MS = 900; // der Suchdienst bremst bei zu vielen Anfragen kurz – dann einmal warten

export const PLACE_CATEGORIES = [
  { id: 'fuel', label: 'Tankstelle', fallback: 'Tankstelle', tags: ['amenity:fuel'] },
  { id: 'cafe', label: 'Café & Bäckerei', fallback: 'Café', tags: ['amenity:cafe', 'shop:bakery'] },
  { id: 'fastfood', label: 'Fastfood', fallback: 'Imbiss', tags: ['amenity:fast_food'] },
  {
    id: 'rest',
    label: 'Rastplatz & WC',
    fallback: 'Rastplatz',
    tags: ['highway:rest_area', 'highway:services', 'amenity:toilets', 'leisure:picnic_site'],
  },
];

/**
 * @param category Eintrag aus PLACE_CATEGORIES
 * @param origin aktueller Standort {lng, lat}
 * @param route optional: Route, entlang der gesucht wird ({coords, cumulative})
 * @param fromAlong auf der Route bereits zurückgelegte Strecke
 * @param onPartial wird mit den bisherigen Treffern aufgerufen, sobald ein Abschnitt abgefragt ist
 * @returns Orte mit aheadMeters/detourMeters (entlang der Route) oder distanceMeters (in der Nähe)
 */
export async function findPlaces(category, { origin, route, fromAlong = 0, signal, onPartial }) {
  if (route) {
    const places = await searchAlongRoute(category, route, fromAlong, signal, onPartial);
    if (places.length) return places;
    // Entlang der Route nichts gefunden – dann wenigstens in der Nähe schauen.
  }
  return searchNearby(category, origin, signal);
}

/**
 * Die Strecke voraus wird in Abschnitten abgefragt – nacheinander, weil der kostenlose Suchdienst
 * mehrere Anfragen auf einmal teilweise abweist. Der nächste Abschnitt kommt zuerst, damit die
 * nächstgelegenen Treffer sofort da sind.
 */
async function searchAlongRoute(category, route, fromAlong, signal, onPartial) {
  const routeEnd = route.cumulative.at(-1);
  const span = Math.min(routeEnd, fromAlong + ROUTE_AHEAD_METERS) - fromAlong;
  if (span < 500) return [];

  const step = span / ROUTE_SAMPLES;
  // Jeder Suchkreis deckt seinen Abschnitt ab (halbe Abschnittslänge plus etwas Luft für Kurven).
  const radiusKm = Math.min(8, Math.max(3, (step / 2000) * 1.2));
  const found = [];
  let failures = 0;

  for (let i = 0; i < ROUTE_SAMPLES; i++) {
    const point = pointAtAlong(route, fromAlong + step * (i + 0.5));
    try {
      found.push(...(await fetchPlaces(category, point, radiusKm, 8, signal)));
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      failures++;
      continue;
    }
    if (i < ROUTE_SAMPLES - 1) onPartial?.(rankAlongRoute(found, route, fromAlong));
  }
  if (failures === ROUTE_SAMPLES) throw new Error('Keine Verbindung zur Suche. Hast du Internet?');
  return rankAlongRoute(found, route, fromAlong);
}

/** Treffer auf die Route beziehen: wie weit voraus, wie viel Umweg – und die besten auswählen. */
function rankAlongRoute(found, route, fromAlong) {
  const places = [];
  for (const place of dedupe(found)) {
    const { distance: detour, along } = nearestOnRoute(route, place.lng, place.lat, fromAlong);
    if (detour > MAX_DETOUR_METERS || along < fromAlong) continue;
    places.push({ ...place, aheadMeters: along - fromAlong, detourMeters: detour });
  }
  // Erst die besten auswählen (nah an der Strecke schlägt „etwas früher“), dann in Fahrreihenfolge zeigen.
  const rank = (place) => place.aheadMeters + place.detourMeters * DETOUR_WEIGHT;
  return places
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, MAX_RESULTS)
    .sort((a, b) => a.aheadMeters - b.aheadMeters);
}

async function searchNearby(category, origin, signal) {
  if (!origin) throw new Error('Noch kein Standort – bitte kurz warten.');
  const found = dedupe(await fetchPlaces(category, origin, NEARBY_RADIUS_KM, 12, signal));
  return found
    .map((place) => ({ ...place, distanceMeters: distance([origin.lng, origin.lat], [place.lng, place.lat]) }))
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, MAX_RESULTS);
}

/** Punkt auf der Route nach so vielen Metern Fahrstrecke. */
function pointAtAlong(route, meters) {
  const { coords, cumulative } = route;
  const target = Math.max(0, Math.min(cumulative.at(-1), meters));
  let i = 0;
  while (i < cumulative.length - 2 && cumulative[i + 1] < target) i++;
  const segment = cumulative[i + 1] - cumulative[i];
  const t = segment > 0 ? (target - cumulative[i]) / segment : 0;
  return {
    lng: coords[i][0] + (coords[i + 1][0] - coords[i][0]) * t,
    lat: coords[i][1] + (coords[i + 1][1] - coords[i][1]) * t,
  };
}

async function fetchPlaces(category, { lng, lat }, radiusKm, limit, signal) {
  const params = new URLSearchParams({
    lat: lat.toFixed(5),
    lon: lng.toFixed(5),
    radius: String(radiusKm),
    limit: String(limit),
    lang: 'de',
  });
  for (const tag of category.tags) params.append('osm_tag', tag);

  // Ein zweiter Versuch nach kurzer Pause, falls der Dienst gerade bremst oder die Verbindung hakt.
  for (let attempt = 0; ; attempt++) {
    let response = null;
    try {
      response = await fetchWithTimeout(`${PHOTON_URL}?${params}`, { signal, timeoutMs: 8000 });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
    }
    if (response?.ok) {
      const data = await response.json();
      return (data.features ?? []).map((feature) => toPlace(feature, category));
    }
    if (attempt >= 1) {
      throw new Error(
        response
          ? `Die Suche ist gerade nicht erreichbar (Fehler ${response.status}).`
          : 'Keine Verbindung zur Suche. Hast du Internet?',
      );
    }
    await pause(RETRY_DELAY_MS, signal);
  }
}

/** Kurz warten – bricht ab, wenn die Suche inzwischen überholt ist. */
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Abgebrochen', 'AbortError'));
    }, { once: true });
  });
}

function toPlace(feature, category) {
  const p = feature.properties;
  const [lng, lat] = feature.geometry.coordinates;
  const street = [p.street, p.housenumber].filter(Boolean).join(' ');
  return {
    id: p.osm_id ? `${p.osm_type ?? ''}${p.osm_id}` : `${lng},${lat}`,
    title: p.name || category.fallback,
    subtitle: [street, p.city ?? p.town ?? p.village ?? p.county].filter(Boolean).join(', '),
    lng,
    lat,
  };
}

/** Dieselbe Tankstelle taucht bei benachbarten Suchpunkten mehrfach auf. */
function dedupe(places) {
  const seen = new Set();
  return places.filter((place) => !seen.has(place.id) && seen.add(place.id));
}
