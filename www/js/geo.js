//
// geo.js - distances and positions along a route, in metres
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// A city is small: an equirectangular projection around the route's latitude is exact to a few
// centimetres over Madrid, and cheap enough to run for every bus every tick.
//
const R = 6371008.8;
const RAD = Math.PI / 180;

//
// metres - the distance between two [lon, lat]
//
export function metres(a, b) {
  const kx = Math.cos(((a[1] + b[1]) / 2) * RAD) * RAD * R;
  const dx = (b[0] - a[0]) * kx;
  const dy = (b[1] - a[1]) * RAD * R;
  return Math.hypot(dx, dy);
}

//
// Route - a LineString, walked by distance from its start
//
export class Route {
  constructor(coords) {
    this.coords = coords.map((c) => [c[0], c[1]]);
    this.kx = Math.cos(this.coords[0][1] * RAD) * RAD * R;      // metres per degree of longitude, here
    this.ky = RAD * R;
    this.cum = [0];
    for (let ix = 1; ix < this.coords.length; ix++) this.cum.push(this.cum[ix - 1] + this.seg(ix - 1));
    this.length = this.cum[this.cum.length - 1];
  }

  seg(ix) {
    const a = this.coords[ix], b = this.coords[ix + 1];
    return Math.hypot((b[0] - a[0]) * this.kx, (b[1] - a[1]) * this.ky);
  }

  //
  // at - the position and the bearing (degrees from north, clockwise) 'd' metres along the route
  //
  at(d) {
    d = Math.max(0, Math.min(this.length, d));
    let lo = 0, hi = this.cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= d) lo = mid; else hi = mid;
    }

    const a = this.coords[lo], b = this.coords[hi];
    const len = this.cum[hi] - this.cum[lo];
    const t = len > 0 ? (d - this.cum[lo]) / len : 0;
    const dx = (b[0] - a[0]) * this.kx, dy = (b[1] - a[1]) * this.ky;
    const bearing = (Math.atan2(dx, dy) / RAD + 360) % 360;

    return { pos: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], bearing };
  }

  //
  // project - the distance along the route of the point of it nearest to 'p', and how far 'p' is from it
  //
  project(p) {
    let best = { d: 0, off: Infinity };

    for (let ix = 0; ix < this.coords.length - 1; ix++) {
      const a = this.coords[ix], b = this.coords[ix + 1];
      const ax = 0, ay = 0;
      const bx = (b[0] - a[0]) * this.kx, by = (b[1] - a[1]) * this.ky;
      const px = (p[0] - a[0]) * this.kx, py = (p[1] - a[1]) * this.ky;
      const l2 = bx * bx + by * by;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * bx + (py - ay) * by) / l2)) : 0;
      const off = Math.hypot(px - t * bx, py - t * by);

      if (off < best.off) best = { d: this.cum[ix] + t * Math.sqrt(l2), off };
    }

    return best;
  }
}
