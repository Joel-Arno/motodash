// Orts- und Adresssuche über Photon (komoot, OpenStreetMap-Daten, kostenlos).

const PHOTON_URL = 'https://photon.komoot.io';

/** Sucht Orte/Adressen, bevorzugt in der Nähe von `near`. */
export async function searchPlaces(query, near, signal) {
  const params = new URLSearchParams({ q: query, lang: 'de', limit: '8' });
  if (near) {
    params.set('lat', near.lat.toFixed(4));
    params.set('lon', near.lng.toFixed(4));
  }
  const data = await getJson(`${PHOTON_URL}/api/?${params}`, signal);
  const seen = new Set();
  return data.features.map(toPlace).filter((place) => {
    const key = `${place.title}|${place.subtitle}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Adresse zu einer Koordinate (z. B. „aktuellen Standort speichern“). */
export async function reversePlace(lng, lat, signal) {
  const params = new URLSearchParams({ lat: lat.toFixed(6), lon: lng.toFixed(6), lang: 'de' });
  const data = await getJson(`${PHOTON_URL}/reverse?${params}`, signal);
  const feature = data.features[0];
  const place = feature ? toPlace(feature) : { title: 'Gespeicherter Ort', subtitle: '' };
  // Die gespeicherte Position ist der eigene Standort, nicht die gefundene Adresse.
  return { ...place, lng, lat };
}

async function getJson(url, signal) {
  let response;
  try {
    response = await fetch(url, { signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error('Keine Verbindung zur Suche. Hast du Internet?');
  }
  if (!response.ok) throw new Error(`Die Suche ist gerade nicht erreichbar (Fehler ${response.status}).`);
  return response.json();
}

function toPlace(feature) {
  const p = feature.properties;
  const [lng, lat] = feature.geometry.coordinates;
  const street = p.street ? [p.street, p.housenumber].filter(Boolean).join(' ') : '';
  const title = p.name || street || p.city || p.county || 'Unbenannter Ort';
  const town = [p.postcode, p.city || p.district].filter(Boolean).join(' ');

  const details = [];
  if (p.name && street) details.push(street);
  if (town && town !== title) details.push(town);
  if (p.countrycode && p.countrycode !== 'DE' && p.country) details.push(p.country);
  if (!details.length && p.state && p.state !== title) details.push(p.state);

  return { title, subtitle: details.join(', '), lng, lat };
}
