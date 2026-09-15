// Simulierte Fahrt entlang einer festen Strecke – zum Testen ohne Motorrad.
// Liefert Positionen im selben Format wie das echte GPS.

import { angleDiff, bearing, distance } from './geo.js?v=1.1';
import DEMO_ROUTE from './demo-route.js?v=1.1';

const TICK_MS = 1000;
const MAX_SPEED = 100 / 3.6; // m/s
const MIN_SPEED = 30 / 3.6;
const ACCELERATION = 2; // m/s pro Sekunde
const BRAKING = 3.5;

export class DemoRide {
  constructor(onPosition, coords = DEMO_ROUTE) {
    this.onPosition = onPosition;
    this.coords = coords;
    this.cumulative = [0];
    for (let i = 1; i < coords.length; i++) {
      this.cumulative.push(this.cumulative[i - 1] + distance(coords[i - 1], coords[i]));
    }
    this.total = this.cumulative.at(-1);
    this.travelled = 0;
    this.speed = 0;
    this.timer = null;
  }

  start() {
    this.emit();
    this.timer = setInterval(() => this.step(), TICK_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  step() {
    const dv = this.targetSpeed() - this.speed;
    this.speed += Math.max(-BRAKING, Math.min(ACCELERATION, dv)) * (TICK_MS / 1000);
    this.travelled += this.speed * (TICK_MS / 1000);
    if (this.travelled >= this.total) {
      this.travelled = 0;
      this.speed = 0;
    }
    this.emit();
  }

  emit() {
    const [lng, lat] = this.pointAt(this.travelled);
    this.onPosition({
      lng,
      lat,
      accuracy: 5,
      speed: this.speed,
      heading: bearing(this.pointAt(this.travelled - 5), this.pointAt(this.travelled + 15)),
      altitude: null,
      timestamp: Date.now(),
    });
  }

  /** Langsamer werden, wenn in den nächsten ~200 m eine enge Kurve kommt. */
  targetSpeed() {
    let sharpest = 0;
    for (let d = 0; d <= 180; d += 15) {
      const at = this.travelled + d;
      const before = bearing(this.pointAt(at), this.pointAt(at + 30));
      const after = bearing(this.pointAt(at + 30), this.pointAt(at + 60));
      sharpest = Math.max(sharpest, Math.abs(angleDiff(before, after)));
    }
    const t = Math.min(1, Math.max(0, (sharpest - 10) / 60));
    return MAX_SPEED - (MAX_SPEED - MIN_SPEED) * t;
  }

  /** Punkt nach `meters` Metern auf der Strecke. */
  pointAt(meters) {
    const d = Math.min(Math.max(meters, 0), this.total);
    let lo = 0;
    let hi = this.cumulative.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (this.cumulative[mid] <= d) lo = mid;
      else hi = mid;
    }
    const segment = this.cumulative[hi] - this.cumulative[lo];
    const t = segment > 0 ? (d - this.cumulative[lo]) / segment : 0;
    const [lng1, lat1] = this.coords[lo];
    const [lng2, lat2] = this.coords[hi];
    return [lng1 + (lng2 - lng1) * t, lat1 + (lat2 - lat1) * t];
  }
}
