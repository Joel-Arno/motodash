// Wetter über Open-Meteo (kostenlos, ohne Anmeldung): aktuell, Regen der nächsten 2 Stunden, nächste Stunden.

const API_URL = 'https://api.open-meteo.com/v1/forecast';
const RAIN_MM_PER_15_MIN = 0.2; // ab hier zählt es als Regen (leichter Niesel darunter nicht)

export async function fetchWeather({ lng, lat }) {
  const params = new URLSearchParams({
    latitude: lat.toFixed(3),
    longitude: lng.toFixed(3),
    current: 'temperature_2m,weather_code,precipitation,is_day',
    minutely_15: 'precipitation',
    forecast_minutely_15: '8',
    hourly: 'temperature_2m,precipitation_probability,weather_code,is_day',
    forecast_hours: '7',
    timezone: 'auto',
  });

  let response;
  try {
    response = await fetch(`${API_URL}?${params}`);
  } catch {
    throw new Error('Keine Verbindung zum Wetterdienst.');
  }
  if (!response.ok) throw new Error(`Wetter nicht verfügbar (Fehler ${response.status}).`);
  const data = await response.json();

  // Zeiten kommen als Ortszeit ohne Zeitzone – mit dem mitgelieferten Versatz in echte Zeitpunkte umrechnen.
  const toEpoch = (time) => Date.parse(`${time}Z`) - data.utc_offset_seconds * 1000;

  const slots = data.minutely_15.time.map((time, i) => ({
    // Der Wert gilt für die 15 Minuten vor dem Zeitstempel.
    start: toEpoch(time) - 15 * 60 * 1000,
    mm: data.minutely_15.precipitation[i] ?? 0,
  }));

  return {
    fetchedAt: Date.now(),
    lng,
    lat,
    temperature: data.current.temperature_2m,
    code: data.current.weather_code,
    isDay: Boolean(data.current.is_day),
    precipitationNow: data.current.precipitation,
    slots,
    hours: data.hourly.time.map((time, i) => ({
      time: toEpoch(time),
      temperature: data.hourly.temperature_2m[i],
      rainChance: data.hourly.precipitation_probability[i],
      code: data.hourly.weather_code[i],
      isDay: Boolean(data.hourly.is_day[i]),
    })),
  };
}

/** Kurzfassung fürs Cockpit: „trocken“, „Regen in 40 min“, „Regen“ – zählt mit der Zeit herunter. */
export function rainSummary(weather, now = Date.now()) {
  const SLOT_MS = 15 * 60 * 1000;
  const isRain = (slot) => slot.mm >= RAIN_MM_PER_15_MIN;
  const current = weather.slots.find((slot) => slot.start <= now && now < slot.start + SLOT_MS);
  const justFetched = now - weather.fetchedAt < SLOT_MS;
  if ((current && isRain(current)) || (justFetched && weather.precipitationNow >= 0.1)) return { text: 'Regen', warn: true };

  const upcoming = weather.slots.find((slot) => slot.start > now && isRain(slot));
  if (upcoming) {
    const minutes = Math.round((upcoming.start - now) / 60000);
    return { text: minutes < 5 ? 'Regen gleich' : `Regen in ${minutes} min`, warn: true };
  }
  return { text: 'trocken', warn: false };
}

/** WMO-Wettercode → Symbol und Beschreibung. */
export function describeWeather(code, isDay = true) {
  if (code === 0) return { icon: isDay ? '☀️' : '🌙', text: 'Klar' };
  if (code === 1) return { icon: isDay ? '🌤️' : '🌙', text: 'Überwiegend klar' };
  if (code === 2) return { icon: '⛅', text: 'Teilweise bewölkt' };
  if (code === 3) return { icon: '☁️', text: 'Bedeckt' };
  if (code === 45 || code === 48) return { icon: '🌫️', text: 'Nebel' };
  if (code >= 51 && code <= 57) return { icon: '🌦️', text: 'Nieselregen' };
  if (code >= 61 && code <= 67) return { icon: '🌧️', text: 'Regen' };
  if (code >= 71 && code <= 77) return { icon: '🌨️', text: 'Schnee' };
  if (code >= 80 && code <= 82) return { icon: '🌦️', text: 'Regenschauer' };
  if (code === 85 || code === 86) return { icon: '🌨️', text: 'Schneeschauer' };
  if (code >= 95) return { icon: '⛈️', text: 'Gewitter' };
  return { icon: '🌡️', text: 'Wetter' };
}
