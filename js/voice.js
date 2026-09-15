// Sprachansagen über die Sprachausgabe des Geräts (auf dem iPhone auch über Bluetooth-Headsets).

let muted = false;
let germanVoice = null;

const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;

function pickVoice() {
  const voices = synth?.getVoices() ?? [];
  germanVoice =
    voices.find((v) => v.lang === 'de-DE' && v.localService) ??
    voices.find((v) => v.lang === 'de-DE') ??
    voices.find((v) => v.lang?.startsWith('de')) ??
    null;
}

if (synth) {
  pickVoice();
  synth.addEventListener?.('voiceschanged', pickVoice);
}

export const voiceSupported = Boolean(synth);

export function setMuted(value) {
  muted = value;
  if (muted) synth?.cancel();
}

/**
 * @param {string} text
 * @param {{interrupt?: boolean}} options interrupt = laufende Ansage abbrechen (wichtige „Jetzt“-Ansage)
 */
export function speak(text, { interrupt = false } = {}) {
  if (!synth || muted || !text) return;
  if (interrupt) synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'de-DE';
  if (germanVoice) utterance.voice = germanVoice;
  synth.speak(utterance);
}

/** iOS spricht erst, nachdem einmal in einer Tipp-Aktion gesprochen wurde – still „freischalten“. */
export function unlockVoice() {
  if (!synth) return;
  const utterance = new SpeechSynthesisUtterance(' ');
  utterance.volume = 0;
  synth.speak(utterance);
}
