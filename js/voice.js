// Sprachansagen über die Sprachausgabe des Geräts (auf dem iPhone auch über Bluetooth-Headsets).

let muted = false;
let voices = []; // alle deutschen Stimmen des Geräts
let defaultVoice = null;
let chosenUri = null;
const sound = { rate: 1, pitch: 1 };
const listeners = [];

const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;

function refreshVoices() {
  voices = (synth?.getVoices() ?? []).filter((voice) => voice.lang?.toLowerCase().startsWith('de'));
  defaultVoice =
    voices.find((voice) => voice.lang === 'de-DE' && voice.localService) ??
    voices.find((voice) => voice.lang === 'de-DE') ??
    voices[0] ??
    null;
}

if (synth) {
  refreshVoices();
  // iOS meldet die Liste oft erst kurz nach dem Start nach.
  synth.addEventListener?.('voiceschanged', () => {
    refreshVoices();
    listeners.forEach((listener) => listener());
  });
}

export const voiceSupported = Boolean(synth);

// Apple verrät die Güte der Stimme in der Kennung: compact = mitgeliefert, enhanced/premium = nachgeladen.
const QUALITY_NAMES = [
  [/premium/i, 'Premium'],
  [/enhanced/i, 'Verbessert'],
];

const voiceQuality = (uri = '') => QUALITY_NAMES.find(([pattern]) => pattern.test(uri))?.[1] ?? '';

/**
 * Alle deutschen Stimmen des Geräts – für die Auswahl in den Einstellungen.
 * Doppelte Einträge fallen weg: iOS meldet dieselbe Stimme oft mehrfach.
 */
export function germanVoices() {
  refreshVoices();
  const seen = new Set();
  const list = [];
  for (const voice of voices) {
    const quality = voiceQuality(voice.voiceURI);
    const key = `${voice.name}|${quality}|${voice.lang}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ uri: voice.voiceURI, name: voice.name, lang: voice.lang, quality });
  }
  return list;
}

/** Wird aufgerufen, wenn das Gerät neue Stimmen meldet. */
export function onVoicesChanged(listener) {
  listeners.push(listener);
}

/** @param uri voiceURI der gewünschten Stimme, null = Stimme des Geräts */
export function setVoice(uri) {
  chosenUri = uri || null;
}

/** Sprechtempo und Tonhöhe (1 = normal). */
export function setVoiceSound({ rate, pitch }) {
  if (Number.isFinite(rate)) sound.rate = rate;
  if (Number.isFinite(pitch)) sound.pitch = pitch;
}

function currentVoice() {
  if (!voices.length) refreshVoices();
  return voices.find((voice) => voice.voiceURI === chosenUri) ?? defaultVoice;
}

export function setMuted(value) {
  muted = value;
  if (muted) synth?.cancel();
}

/**
 * @param {string} text
 * @param {{interrupt?: boolean, force?: boolean}} options
 *   interrupt = laufende Ansage abbrechen (wichtige „Jetzt“-Ansage),
 *   force = auch sprechen, wenn stumm geschaltet ist (Hörprobe in den Einstellungen)
 */
export function speak(text, { interrupt = false, force = false } = {}) {
  if (!synth || (muted && !force) || !text) return;
  if (interrupt || force) synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'de-DE';
  utterance.rate = sound.rate;
  utterance.pitch = sound.pitch;
  const voice = currentVoice();
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  }
  synth.speak(utterance);
}

/** iOS spricht erst, nachdem einmal in einer Tipp-Aktion gesprochen wurde – still „freischalten“. */
export function unlockVoice() {
  if (!synth) return;
  const utterance = new SpeechSynthesisUtterance(' ');
  utterance.volume = 0;
  synth.speak(utterance);
  refreshVoices(); // nach dem ersten Sprechen ist die Liste auf dem iPhone vollständig
}
