// Tankreichweite: Kilometer seit dem letzten Tanken, auf dem Gerät gespeichert.
// Gezählt wird nur bei echter Fahrt (nicht in der Demo) und nur, wenn die Funktion eingeschaltet ist.

const FUEL_KEY = 'motodash.fuel';
const WARN_SHARE = 0.15; // Warnung ab den letzten 15 % der Reichweite …
const WARN_MIN_KM = 40; // … mindestens aber 40 km vorher
const URGENT_KM = 15;

/** @returns {{enabled: boolean, rangeKm: number, sinceMeters: number}} */
export function loadFuel() {
  const defaults = { enabled: false, rangeKm: 250, sinceMeters: 0 };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(FUEL_KEY)) };
  } catch {
    return defaults;
  }
}

export function saveFuel(fuel) {
  try {
    localStorage.setItem(FUEL_KEY, JSON.stringify(fuel));
  } catch {
    // Ohne Speicher zählt der Zähler nur bis zum Schließen der App.
  }
}

/** Wie weit reicht der Tank noch? level: 'off' | 'ok' | 'warn' (bald tanken) | 'bad' (dringend) */
export function fuelStatus(fuel) {
  const usedKm = fuel.sinceMeters / 1000;
  const leftKm = Math.max(0, fuel.rangeKm - usedKm);
  const warnKm = Math.max(WARN_MIN_KM, fuel.rangeKm * WARN_SHARE);
  let level = 'ok';
  if (!fuel.enabled) level = 'off';
  else if (leftKm <= URGENT_KM) level = 'bad';
  else if (leftKm <= warnKm) level = 'warn';
  return { usedKm, leftKm, level };
}
