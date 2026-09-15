// Kleine Geo-Hilfsfunktionen. Koordinaten immer als [lng, lat].

const EARTH_RADIUS = 6371000;
const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/** Entfernung in Metern. */
export function distance([lng1, lat1], [lng2, lat2]) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(a));
}

/** Kompassrichtung von a nach b in Grad (0 = Norden). */
export function bearing([lng1, lat1], [lng2, lat2]) {
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Kürzeste Drehung von a nach b in Grad (-180 … 180). */
export function angleDiff(a, b) {
  return ((b - a + 540) % 360) - 180;
}
