// Fahrt-Auswertung: Strecke, Zeiten, Tempo, Höhenmeter und maximale Schräglage.
//
// Schräglage: Ein am Lenker montiertes Handy kann die Schräglage mit seinen Lagesensoren kaum messen –
// in der Kurve drückt die Fliehkraft genau so, dass „unten“ für das Handy weiter Richtung Motorrad zeigt.
// Deshalb rechnen wir physikalisch aus Tempo und Kurvenrate: tan(Schräglage) = Tempo × Drehrate / g.

import { angleDiff, bearing, distance } from './geo.js?v=1.2.1';

const G = 9.81;
const MIN_LEAN_SPEED_KMH = 20; // darunter ist die GPS-Richtung zu unruhig
const MAX_LEAN_DEG = 60;
const MAX_ACCURACY_METERS = 40;
const CLIMB_STEP_METERS = 5; // gegen GPS-Rauschen bei der Höhe

export class RideStats {
  constructor() {
    this.startedAt = Date.now();
    this.meters = 0;
    this.movingMs = 0;
    this.maxKmh = 0;
    this.maxLeanLeft = 0;
    this.maxLeanRight = 0;
    this.climbMeters = 0;
    this.prev = null;
    this.prevCourse = null;
    this.turnRates = [];
    this.altitudeRef = null;
  }

  /** @param fix GPS-Punkt ({lng, lat, accuracy, altitude, timestamp}) @param speedKmh bereinigtes Tempo */
  add(fix, speedKmh) {
    if ((fix.accuracy ?? 0) > MAX_ACCURACY_METERS) return;
    const prev = this.prev;
    this.prev = fix;
    if (!prev) return;

    const seconds = (fix.timestamp - prev.timestamp) / 1000;
    if (seconds <= 0 || seconds > 10) {
      this.prevCourse = null;
      return;
    }
    const meters = distance([prev.lng, prev.lat], [fix.lng, fix.lat]);

    if (speedKmh >= 3) this.meters += meters;
    if (speedKmh >= 5) this.movingMs += seconds * 1000;
    this.maxKmh = Math.max(this.maxKmh, speedKmh);
    this.trackClimb(fix.altitude);
    this.trackLean(prev, fix, meters, seconds, speedKmh);
  }

  trackClimb(altitude) {
    if (!Number.isFinite(altitude)) return;
    if (this.altitudeRef == null) {
      this.altitudeRef = altitude;
    } else if (altitude - this.altitudeRef >= CLIMB_STEP_METERS) {
      this.climbMeters += altitude - this.altitudeRef;
      this.altitudeRef = altitude;
    } else if (this.altitudeRef - altitude >= CLIMB_STEP_METERS) {
      this.altitudeRef = altitude;
    }
  }

  trackLean(prev, fix, meters, seconds, speedKmh) {
    if (speedKmh < MIN_LEAN_SPEED_KMH || meters < 3) {
      this.prevCourse = null;
      this.turnRates = [];
      return;
    }
    const course = bearing([prev.lng, prev.lat], [fix.lng, fix.lat]);
    if (this.prevCourse != null) {
      // Median der letzten drei Drehraten – einzelne GPS-Ausreißer zählen nicht.
      this.turnRates = [...this.turnRates.slice(-2), angleDiff(this.prevCourse, course) / seconds];
      if (this.turnRates.length === 3) {
        const rate = [...this.turnRates].sort((a, b) => a - b)[1];
        const lean = (Math.atan(((speedKmh / 3.6) * rate * Math.PI) / 180 / G) * 180) / Math.PI;
        const clamped = Math.min(MAX_LEAN_DEG, Math.abs(lean));
        if (lean > 0) this.maxLeanRight = Math.max(this.maxLeanRight, clamped);
        else this.maxLeanLeft = Math.max(this.maxLeanLeft, clamped);
      }
    }
    this.prevCourse = course;
  }

  summary() {
    const movingSeconds = this.movingMs / 1000;
    return {
      endedAt: Date.now(),
      startedAt: this.startedAt,
      meters: this.meters,
      movingSeconds,
      totalSeconds: (Date.now() - this.startedAt) / 1000,
      avgKmh: movingSeconds > 60 ? this.meters / 1000 / (movingSeconds / 3600) : 0,
      maxKmh: this.maxKmh,
      maxLeanLeft: Math.round(this.maxLeanLeft),
      maxLeanRight: Math.round(this.maxLeanRight),
      climbMeters: Math.round(this.climbMeters),
    };
  }
}
