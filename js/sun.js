// Sonnenauf- und -untergang für einen Ort – reine Rechnung, ohne Internet.
// Nach dem üblichen Verfahren (Sonnenstand aus dem Julianischen Datum), genau auf etwa eine Minute.

const RAD = Math.PI / 180;
const DAY_MS = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;
const J0 = 0.0009;
const OBLIQUITY = RAD * 23.4397; // Neigung der Erdachse
const HORIZON = RAD * -0.833; // Sonnenmitte etwas unter dem Horizont (Lichtbrechung + Sonnenscheibe)

const toJulian = (date) => date.valueOf() / DAY_MS - 0.5 + J1970;
const fromJulian = (julian) => (julian + 0.5 - J1970) * DAY_MS;

/**
 * @returns {{sunrise: number, sunset: number} | null} Zeitpunkte in ms, null in Polartag/-nacht
 */
export function sunTimes(date, lat, lng) {
  const lw = RAD * -lng;
  const phi = RAD * lat;
  const days = toJulian(date) - J2000;

  const cycle = Math.round(days - J0 - lw / (2 * Math.PI));
  const approxTransit = (angle) => J0 + (angle + lw) / (2 * Math.PI) + cycle;

  const meanAnomaly = RAD * (357.5291 + 0.98560028 * approxTransit(0));
  const center = RAD * (1.9148 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly) + 0.0003 * Math.sin(3 * meanAnomaly));
  const eclipticLongitude = meanAnomaly + center + RAD * 102.9372 + Math.PI;
  const declination = Math.asin(Math.sin(OBLIQUITY) * Math.sin(eclipticLongitude));
  const transitJ = (approx) => J2000 + approx + 0.0053 * Math.sin(meanAnomaly) - 0.0069 * Math.sin(2 * eclipticLongitude);

  const cosHourAngle = (Math.sin(HORIZON) - Math.sin(phi) * Math.sin(declination)) / (Math.cos(phi) * Math.cos(declination));
  if (cosHourAngle > 1 || cosHourAngle < -1) return null; // Sonne geht dort heute nicht auf oder unter
  const hourAngle = Math.acos(cosHourAngle);

  const noon = transitJ(approxTransit(0));
  const set = transitJ(approxTransit(hourAngle));
  return { sunrise: fromJulian(noon - (set - noon)), sunset: fromJulian(set) };
}

/**
 * Tag oder Nacht an diesem Ort? Kurz vor Sonnenuntergang wird schon umgeschaltet,
 * weil es dann zum Fahren bereits dämmrig ist.
 */
export function isNightAt(date, lat, lng, { duskMinutes = 20 } = {}) {
  const times = sunTimes(date, lat, lng);
  if (!times) return null; // kein Sonnenauf-/-untergang – lieber nichts umstellen
  const now = date.valueOf();
  return now < times.sunrise || now > times.sunset - duskMinutes * 60 * 1000;
}
