// Abbiegehinweise während der Fahrt: nächstes Manöver, Zeitpunkt der Ansagen, Abweichung von der Route.
// Enthält keine Oberfläche – app.js zeigt an und spricht.

import { RouteProgress } from './routing.js?v=1.4';

const PASSED_METERS = 10; // ab hier gilt ein Manöver als erledigt
const OFF_ROUTE_MIN_METERS = 50;
const OFF_ROUTE_SECONDS = 4;
const THEN_WITHIN_METERS = 400; // „Danach …“ nur, wenn das übernächste Manöver bald folgt
const LONG_STRETCH_METERS = 2000; // danach „… weiter der Route folgen“ ansagen

export class Navigation {
  constructor(route) {
    this.route = route;
    this.progress = new RouteProgress(route);
    this.spoken = new Set();
    this.offRouteSince = 0;
    this.lastPassed = 0; // Index des zuletzt erledigten Manövers
  }

  /** Erste Ansage beim Start. */
  startAnnouncement(isTour) {
    const first = this.route.maneuvers[0];
    const intro = isTour ? 'Rundtour gestartet.' : 'Route gestartet.';
    return first?.kind === 'start' ? `${intro} ${first.now}` : intro;
  }

  /**
   * @param {{lng:number, lat:number, accuracy?:number, speedMps?:number, timestamp:number}} fix
   */
  update({ lng, lat, accuracy = 10, speedMps = 0, timestamp }) {
    const progress = this.progress.update(lng, lat);
    const { along } = progress;
    const maneuvers = this.route.maneuvers;

    const nextIndex = maneuvers.findIndex((m) => m.kind !== 'start' && m.along > along + PASSED_METERS);
    const next = maneuvers[nextIndex] ?? null;
    const distanceToNext = next ? next.along - along : 0;
    const following = next ? maneuvers[nextIndex + 1] ?? null : null;
    const then = following && following.along - next.along < THEN_WITHIN_METERS ? following : null;

    // Abweichung: länger als ein paar Sekunden deutlich neben der Route.
    const offRouteLimit = Math.max(OFF_ROUTE_MIN_METERS, (accuracy || 0) * 1.5);
    if (progress.offRouteMeters > offRouteLimit) this.offRouteSince ||= timestamp;
    else this.offRouteSince = 0;
    const offRoute = Boolean(this.offRouteSince) && timestamp - this.offRouteSince >= OFF_ROUTE_SECONDS * 1000;

    return {
      ...progress,
      next,
      then,
      distanceToNext,
      offRoute,
      speedLimit: this.route.speedLimits?.[progress.segmentIndex] ?? 0,
      speech: offRoute ? null : this.speechFor(nextIndex, distanceToNext, then, speedMps),
    };
  }

  /** Was soll jetzt gesagt werden? Jede Ansage kommt nur einmal. */
  speechFor(index, distanceToNext, then, speedMps) {
    const maneuvers = this.route.maneuvers;
    if (index < 0) return null;

    // Gerade ein Manöver geschafft und lange nichts mehr → „13 Kilometer weiter der Route folgen.“
    const passedIndex = index - 1;
    if (passedIndex > this.lastPassed) {
      this.lastPassed = passedIndex;
      const passed = maneuvers[passedIndex];
      if (passed.after && distanceToNext > LONG_STRETCH_METERS && once(this.spoken, `${passedIndex}:after`)) {
        return { text: passed.after, interrupt: false };
      }
    }

    const m = maneuvers[index];
    const speed = Math.max(speedMps, 8);
    const farMeters = clamp(speed * 25, 250, 1500); // Vorwarnung etwa 25 s vorher
    const nearMeters = clamp(speed * 6, 40, 200); // „Jetzt“-Ansage etwa 6 s vorher

    if (distanceToNext <= nearMeters) {
      if (!once(this.spoken, `${index}:now`)) return null;
      this.spoken.add(`${index}:far`);
      let text = nowText(m);
      if (then) text += ` Danach ${lowerFirst(then.kind === 'turn' ? then.alert : shortArrival(then))}`;
      return { text, interrupt: true };
    }

    if (distanceToNext <= farMeters && distanceToNext > nearMeters + 80 && once(this.spoken, `${index}:far`)) {
      return { text: `In ${spokenDistance(distanceToNext)} ${lowerFirst(alertText(m))}`, interrupt: false };
    }
    return null;
  }

  /** Noch nicht erreichte Wegpunkte/Zwischenziele – Ziel fürs Neuberechnen. */
  remainingWaypoints() {
    const { waypoints } = this.route;
    return waypoints.filter((w, i) => i === waypoints.length - 1 || w.along > this.progress.along + 30);
  }
}

function nowText(m) {
  if (m.kind === 'waypoint') return 'Sie haben Ihr Zwischenziel erreicht.';
  if (m.kind === 'destination') return m.now;
  return m.now;
}

function alertText(m) {
  if (m.kind === 'waypoint') return 'Erreichen Sie Ihr Zwischenziel.';
  if (m.kind === 'destination') return 'Erreichen Sie Ihr Ziel.';
  return m.alert;
}

function shortArrival(m) {
  return m.kind === 'waypoint' ? 'Zwischenziel.' : 'Ziel.';
}

/** „In 300 Metern“, „In einem Kilometer“, „In 1,5 Kilometern“ */
export function spokenDistance(meters) {
  if (meters >= 950) {
    const km = Math.round(meters / 500) / 2;
    return km === 1 ? 'einem Kilometer' : `${km.toLocaleString('de-DE')} Kilometern`;
  }
  const rounded = meters > 300 ? Math.round(meters / 100) * 100 : Math.round(meters / 50) * 50;
  return `${Math.max(50, rounded)} Metern`;
}

// Nur übliche Satzanfänge kleinschreiben – Straßennamen („B 500 folgen“) bleiben, wie sie sind.
const LOWERCASE_STARTS = /^(Rechts|Links|Leicht|Scharf|Geradeaus|In|Auf|Am|Im|An|Aus|Bei|Weiter|Wenden|Bitte|Halten|Nehmen|Fahren|Richtung|Das|Die|Den|Der|Erreichen|Zwischenziel|Ziel)\b/;
function lowerFirst(text) {
  return LOWERCASE_STARTS.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
}

function once(set, key) {
  if (set.has(key)) return false;
  set.add(key);
  return true;
}

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

// ---------- Anzeige ----------

/** Symbol-Name für ein Manöver (siehe NAV_ICONS in app.js). */
export function maneuverIcon(m) {
  if (m.kind === 'destination' || m.kind === 'waypoint') return 'flag';
  switch (m.type) {
    case 9:
    case 18:
    case 20:
    case 23:
    case 37:
      return 'slightRight';
    case 10:
    case 2:
      return 'right';
    case 11:
      return 'sharpRight';
    case 12:
    case 13:
      return 'uturn';
    case 14:
      return 'sharpLeft';
    case 15:
    case 3:
      return 'left';
    case 16:
    case 19:
    case 21:
    case 24:
    case 38:
      return 'slightLeft';
    case 26:
      return 'roundabout';
    case 28:
    case 29:
      return 'ferry';
    default:
      return 'straight';
  }
}

const SHORT_DIRECTIONS = {
  slightRight: 'Leicht rechts',
  right: 'Rechts',
  sharpRight: 'Scharf rechts',
  uturn: 'Wenden',
  sharpLeft: 'Scharf links',
  left: 'Links',
  slightLeft: 'Leicht links',
  ferry: 'Fähre',
  straight: 'Geradeaus',
};

/** Hauptzeile im Banner: Straße, Ausfahrt oder Ziel. */
export function maneuverTitle(m, isTour) {
  if (m.kind === 'destination') return isTour ? 'Ende der Rundtour' : 'Ziel';
  if (m.kind === 'waypoint') return 'Zwischenziel';
  const street = m.streets.join(' / ');
  if (m.type === 26 && m.exitCount) return `${m.exitCount}. Ausfahrt${street ? ` · ${street}` : ''}`;
  return street || m.instruction.replace(/\.$/, '');
}

/** Kurzform für „Danach …“ */
export function maneuverShort(m) {
  if (m.kind === 'destination' || m.kind === 'waypoint') return m.kind === 'waypoint' ? 'Zwischenziel' : 'Ziel';
  if (m.type === 26 && m.exitCount) return `${m.exitCount}. Ausfahrt`;
  return SHORT_DIRECTIONS[maneuverIcon(m)];
}
