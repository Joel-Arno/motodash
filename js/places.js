// Tankstellen, Cafés und Rastplätze – in der Nähe oder entlang der Route.
// Quelle ist wie bei der Zielsuche Photon (OpenStreetMap), hier über die Umkreissuche mit Kategorie.

import { distance } from './geo.js?v=1.2.1';
import { nearestOnRoute } from './routing.js?v=1.4';

const PHOTON_URL = 'https://photon.komoot.io/reverse';
const NEARBY_RADIUS_KM = 10;
const ROUTE_RADIUS_KM = 4;
const ROUTE_AHEAD_METERS = 60000; // so weit voraus wird entlang der Route gesucht
const ROUTE_SAMPLES = 5; // an so vielen Stellen der Route wird nachgefragt
const MAX_DETOUR_METERS = 2500; // weiter abseits der Route lohnt der Umweg nicht
const MAX_RESULTS = 8;

export const PLACE_CATEGORIES = [
  { id: 'fuel', label: 'Tankstelle', fallback: 'Tankstelle', tags: ['amenity:fuel'] },
  { id: 'cafe', label: 'Café & Bäckerei', fallback: 'Café', tags: ['amenity:cafe', 'shop:bakery'] },
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
 * @returns Orte mit aheadMeters/detourMeters (entlang der Route) oder distanceMeters (in der Nähe)
 */
export async function findPlaces(category, { origin, route, fromAlong = 0, signal }) {
  if (route) {
    const places = await searchAlongRoute(category, route, fromAlong, signal);
    if (places.length) return places;
    // Entlang der Route nichts gefunden – dann wenigstens in der Nähe schauen.
  }
  return searchNearby(category, origin, signal);
}

async function searchAlongRoute(category, route, fromAlong, signal) {
  const routeEnd = route.cumulative.at(-1);
  const until = Math.min(routeEnd, fromAlong + ROUTE_AHEAD_METERS);
  const span = until - fromAlong;
  if (span < 500) return [];

  const step = span / ROUTE_SAMPLES;
  const samples = [];
  for (let i = 0; i < ROUTE_SAMPLES; i++) samples.push(pointAtAlong(route, fromAlong + step * (i + 0.5)));

  // Einzelne fehlgeschlagene Abfragen sollen die anderen nicht mitreißen.
  const lists = await Promise.all(
    samples.map((point) => fetchPlaces(category, point, ROUTE_RADIUS_KM, 6, signal).catch(() => [])),
  );

  const places = [];
  for (const place of dedupe(lists.flat())) {
    const { distance: detour, along } = nearestOnRoute(route, place.lng, place.lat, fromAlong);
    if (detour > MAX_DETOUR_METERS || along < fromAlong) continue;
    places.push({ ...place, aheadMeters: along - fromAlong, detourMeters: detour });
  }
  places.sort((a, b) => a.aheadMeters - b.aheadMeters);
  return places.slice(0, MAX_RESULTS);
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

  let response;
  try {
    response = await fetch(`${PHOTON_URL}?${params}`, { signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error('Keine Verbindung zur Suche. Hast du Internet?');
  }
  if (!response.ok) throw new Error(`Die Suche ist gerade nicht erreichbar (Fehler ${response.status}).`);
  const data = await response.json();
  return (data.features ?? []).map((feature) => toPlace(feature, category));
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
