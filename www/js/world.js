//
// world.js - the city CDMAD moves: its entities, the buses' simulation, every change as an NGSI-LD update
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// The world is the snapshot's entities (data/snapshot.json), kept here as the broker has them. A change -
// a bus moving, a streetlight breaking - changes the entity here and queues the attributes it changed; flush()
// hands them over as fragments for one batch update ({id, type, <attribute>...}), nothing sent twice.
//
// A bus drives along its route's shape: 'dist' metres from its start, at its set speed - less in the rain,
// a crawl near a congested traffic sensor, none when stopped or broken. It waits DWELL_S at each stop and,
// at the end of the route, turns into the route of the other direction (its onRoute changes).
//
import { Route, metres } from './geo.js';

const DWELL_S = 8;                               // seconds (simulated) at a stop
const JAM_RADIUS_M = 150;                        // a congested sensor this close slows a bus to a crawl
const JAM_KMH = 4;
const RAIN_FACTOR = 0.8;

//
// The air-quality level of an NO2 concentration (µg/m³) - the European Air Quality Index's bands, folded into four
//
export function no2Level(v) {
  if (v <= 40) return 'good';
  if (v <= 120) return 'moderate';
  if (v <= 230) return 'poor';
  return 'veryPoor';
}

const prop = (value, extra = {}) => ({ type: 'Property', value, ...extra });
const rel = (object) => ({ type: 'Relationship', object });
const geo = (coordinates) => ({ type: 'GeoProperty', value: { type: 'Point', coordinates } });
const val = (e, a) => (e && e[a] !== undefined) ? (e[a].value !== undefined ? e[a].value : e[a].object) : undefined;

export class World {
  constructor(snapshot) {
    this.byId = new Map();
    this.routes = new Map();                     // id -> {entity, route: Route, stops: [{id, d}], line, other}
    this.buses = [];                             // {id, entity, routeId, dist, setKmh, kmh, status, dwell, stopIx, occupancy}
    this.dirty = new Map();                      // id -> Set of attributes to send
    this.factor = 1;                             // simulated seconds per real second
    this.raining = false;
    this.night = false;
    this.running = true;

    for (const e of snapshot.entities) this.byId.set(e.id, structuredClone(e));
    this.fallbackStations = snapshot.stationsFallback || [];
    this.index();
  }

  of(type) { return [...this.byId.values()].filter((e) => e.type === type); }

  //
  // index - the routes' geometry and stops, the buses' places on them
  //
  index() {
    for (const e of this.of('PublicTransportRoute')) {
      const coords = e.location && e.location.value && e.location.value.coordinates;
      if (!coords || coords.length < 2) continue;

      const route = new Route(coords);
      const stopIds = (e.hasStop && (e.hasStop.objectList || e.hasStop.object)) || [];
      const stops = [].concat(stopIds).map((s) => (typeof s === 'string' ? s : s.object || s['@id']))
        .map((id) => {
          const s = this.byId.get(id);
          const p = s && s.location && s.location.value && s.location.value.coordinates;
          return p ? { id, d: route.project(p).d } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.d - b.d);

      this.routes.set(e.id, { entity: e, route, stops, line: val(e, 'routeShortName') || '?', other: null });
    }

    for (const [id, r] of this.routes) {                     // the other direction: same line, the other route
      for (const [id2, r2] of this.routes) if (id2 !== id && r2.line === r.line) r.other = id2;
    }

    for (const e of this.of('Bus')) this.place(e);
  }

  //
  // place - a bus's state from its entity (the snapshot's, or the broker's when CDMAD attaches to a running world)
  //
  place(e) {
    const routeId = val(e, 'onRoute');
    const r = this.routes.get(routeId);
    const p = e.location && e.location.value && e.location.value.coordinates;
    if (!r || !p) return;

    const dist = r.route.project(p).d;
    const stopIx = Math.max(0, r.stops.findIndex((s) => s.d > dist));
    const status = val(e, 'status') || 'inService';
    const old = this.buses.find((b) => b.id === e.id);
    const bus = {
      id: e.id, entity: e, routeId, dist,
      setKmh: (old && old.setKmh) || val(e, 'speed') || 25,
      kmh: val(e, 'speed') || 0,
      status: status === 'atStop' ? 'inService' : status,
      dwell: 0, stopIx: stopIx === -1 ? r.stops.length : stopIx,
      occupancy: val(e, 'occupancy') || 30,
    };

    if (old) Object.assign(old, bus); else this.buses.push(bus);
  }

  //
  // set - an attribute of an entity, here and queued for the broker
  //
  set(id, attr, value) {
    const e = this.byId.get(id);
    if (!e) return;
    e[attr] = value;
    if (!this.dirty.has(id)) this.dirty.set(id, new Set());
    this.dirty.get(id).add(attr);
  }

  //
  // flush - the queued changes as fragments for a batch update, and the queue emptied
  //
  flush() {
    const out = [];
    for (const [id, attrs] of this.dirty) {
      const e = this.byId.get(id);
      const f = { id, type: e.type };
      for (const a of attrs) f[a] = e[a];
      out.push(f);
    }
    this.dirty.clear();
    return out;
  }

  //
  // congestedNear - a congested traffic sensor within JAM_RADIUS_M of 'p'
  //
  congestedNear(p) {
    for (const t of this.of('TrafficFlowObserved')) {
      if (val(t, 'congested') !== true) continue;
      const q = t.location && t.location.value && t.location.value.coordinates;
      if (q && metres(p, q) < JAM_RADIUS_M) return true;
    }
    return false;
  }

  //
  // tick - 'dt' real seconds of the simulation
  //
  tick(dt) {
    if (!this.running) return;
    const sdt = dt * this.factor;

    for (const b of this.buses) {
      const r = this.routes.get(b.routeId);
      if (!r) continue;
      const before = { kmh: b.kmh, status: b.status, routeId: b.routeId, stopIx: b.stopIx, occupancy: b.occupancy };

      if (b.status === 'broken' || b.status === 'stopped') b.kmh = 0;
      else if (b.dwell > 0) {
        b.dwell -= sdt;
        b.kmh = 0;
        if (b.dwell <= 0) b.status = 'inService';
      }
      else {
        const here = r.route.at(b.dist).pos;
        let kmh = b.setKmh * (this.raining ? RAIN_FACTOR : 1);
        if (this.congestedNear(here)) kmh = Math.min(kmh, JAM_KMH);
        kmh = Math.max(0, kmh + (Math.random() - 0.5) * 2);    // a driver is not a cruise control
        b.kmh = kmh;
        b.dist += (kmh / 3.6) * sdt;

        const next = r.stops[b.stopIx];
        if (next && b.dist >= next.d) {                          // at the next stop: people off, people on
          b.dist = next.d;
          b.dwell = DWELL_S;
          b.status = 'atStop';
          b.kmh = 0;
          b.stopIx++;
          b.occupancy = Math.max(5, Math.min(100, Math.round(b.occupancy + (Math.random() - 0.45) * 30)));
        }

        if (b.dist >= r.route.length && r.other) {               // the end of the line: back the other way
          b.routeId = r.other;
          b.dist = 0;
          b.stopIx = 0;
        }
      }

      this.publish(b, before);
    }
  }

  //
  // publish - a bus's state onto its entity: the location always, the rest when it changed
  //
  publish(b, before) {
    const r = this.routes.get(b.routeId);
    const { pos, bearing } = r.route.at(b.dist);
    const coords = [Math.round(pos[0] * 1e6) / 1e6, Math.round(pos[1] * 1e6) / 1e6];
    const e = this.byId.get(b.id);
    const old = e.location && e.location.value && e.location.value.coordinates;

    if (!old || old[0] !== coords[0] || old[1] !== coords[1]) {
      this.set(b.id, 'location', geo(coords));
      this.set(b.id, 'bearing', prop(Math.round(bearing)));
    }

    const kmh = Math.round(b.kmh);
    if (val(e, 'speed') !== kmh) this.set(b.id, 'speed', prop(kmh, { unitCode: 'KMH' }));
    if (!before || b.status !== before.status) this.set(b.id, 'status', prop(b.status));
    if (!before || b.occupancy !== before.occupancy) this.set(b.id, 'occupancy', prop(b.occupancy, { unitCode: 'P1' }));
    if (!before || b.routeId !== before.routeId) this.set(b.id, 'onRoute', rel(b.routeId));

    const next = r.stops[b.stopIx];
    if (next && val(e, 'nextStop') !== next.id) this.set(b.id, 'nextStop', rel(next.id));
  }

  //
  // The controls
  //
  bus(id) { return this.buses.find((b) => b.id === id); }

  busSpeed(id, kmh) { const b = this.bus(id); if (b) b.setKmh = kmh; }

  busStatus(id, status) {                        // 'inService', 'stopped', 'broken'
    const b = this.bus(id);
    if (!b) return;
    const before = { kmh: b.kmh, status: b.status, routeId: b.routeId, stopIx: b.stopIx, occupancy: b.occupancy };
    b.status = status;
    b.dwell = 0;
    if (status !== 'inService') b.kmh = 0;
    this.publish(b, before);
  }

  lampStatus(id, status) {                       // 'ok', 'broken' - a broken lamp gives no light
    this.set(id, 'status', prop(status));
    this.set(id, 'powerState', prop(status === 'broken' ? 'off' : (this.night ? 'on' : 'off')));
  }

  setNight(night) {
    this.night = night;
    for (const l of this.of('Streetlight')) {
      const want = (night && val(l, 'status') !== 'broken') ? 'on' : 'off';
      if (val(l, 'powerState') !== want) this.set(l.id, 'powerState', prop(want));
    }
  }

  setNo2(id, v) {
    const now = new Date().toISOString();
    this.set(id, 'NO2', prop(v, { unitCode: 'GQ', observedAt: now }));
    this.set(id, 'airQualityLevel', prop(no2Level(v), { observedAt: now }));
  }

  setRain(raining) {
    this.raining = raining;
    const now = new Date().toISOString();
    for (const w of this.of('WeatherObserved')) {
      this.set(w.id, 'precipitation', prop(raining ? Math.round((3 + Math.random() * 4) * 10) / 10 : 0, { unitCode: 'H67', observedAt: now }));
      const h = val(w, 'relativeHumidity');
      if (h !== undefined) this.set(w.id, 'relativeHumidity', prop(raining ? Math.max(h, 88) : Math.min(h, 55), { unitCode: 'P1', observedAt: now }));
    }
  }

  setJam(id, jammed) {
    const now = new Date().toISOString();
    const t = this.byId.get(id);
    if (!t) return;
    this.set(id, 'congested', prop(jammed, { observedAt: now }));
    this.set(id, 'load', prop(jammed ? 95 : 35, { unitCode: 'P1', observedAt: now }));
    this.set(id, 'intensity', prop(jammed ? 2600 : 900, { observedAt: now }));
  }

  //
  // apply - fragments from the broker or from Madrid (data/live.json): taken into the world as they are
  //
  apply(fragments) {
    for (const f of fragments) {
      const e = this.byId.get(f.id);
      if (!e) { this.byId.set(f.id, structuredClone(f)); continue; }
      for (const [k, v] of Object.entries(f)) if (k !== 'id' && k !== 'type' && k !== '@context') e[k] = v;
    }
  }
}

export { val };
