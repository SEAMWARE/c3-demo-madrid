//
// mapview.js - CDMAD's map: the world drawn, and the things on it that can be clicked
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// MapLibre GL JS, with OpenFreeMap's dark style when the network is there - and a plain background when
// it is not: the routes, stops, streetlights and stations are the demo's own data, drawn either way.
// Labels need the style's glyphs: offline, the buses go without their line number.
//
import { val } from './world.js';

const STYLE_ONLINE = 'https://tiles.openfreemap.org/styles/dark';
const STYLE_OFFLINE = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0E1014' } }] };

const LINE_COLOURS = ['#2EC4B6', '#E58AB1', '#F2B84B', '#7CA7FF'];
const LEVEL_COLOURS = { good: '#6FDCA0', moderate: '#F2B84B', poor: '#FF9F5A', veryPoor: '#FF5A6E' };

async function onlineStyle() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);
    const r = await fetch(STYLE_ONLINE, { signal: ctl.signal });
    clearTimeout(t);
    return r.ok ? STYLE_ONLINE : null;
  } catch { return null; }
}

const point = (e) => e.location && e.location.value && e.location.value.type === 'Point' ? e.location.value.coordinates : null;
const fc = (features) => ({ type: 'FeatureCollection', features });

export class MapView {
  constructor(container, { onClick }) {
    this.container = container;
    this.onClick = onClick;                      // (kind, id)
    this.map = null;
    this.lineColour = new Map();                 // routeShortName -> colour
    this.selected = null;                        // the selected bus
    this.selectedLamp = null;
    this.online = false;
  }

  async init(center, zoom) {
    const m = await import('../vendor/maplibre-gl/maplibre-gl.mjs');
    const maplibregl = m.default || m;
    const online = await onlineStyle();
    this.online = online !== null;

    this.map = new maplibregl.Map({ container: this.container, style: online || STYLE_OFFLINE, center, zoom, attributionControl: { compact: true } });
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    await new Promise((resolve) => this.map.on('load', resolve));

    const add = (id, source, type, paint, extra = {}) => this.map.addLayer({ id, source, type, paint, ...extra });
    for (const s of ['routes', 'stops', 'lamps', 'air', 'weather', 'traffic', 'buses']) this.map.addSource(s, { type: 'geojson', data: fc([]) });

    add('routes-casing', 'routes', 'line', { 'line-color': '#0E1014', 'line-width': 7 }, { layout: { 'line-cap': 'round', 'line-join': 'round' } });
    add('routes', 'routes', 'line', { 'line-color': ['get', 'colour'], 'line-width': 3.5, 'line-opacity': 0.9 }, { layout: { 'line-cap': 'round', 'line-join': 'round' } });
    add('lamps', 'lamps', 'circle', {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 1.6, 16, 4],
      'circle-color': ['match', ['get', 'state'], 'broken', '#FF5A6E', 'on', '#FFD36B', '#4A515E'],
      'circle-stroke-width': ['case', ['get', 'sel'], 3, ['==', ['get', 'state'], 'broken'], 2, 0],
      'circle-stroke-color': ['case', ['get', 'sel'], '#ECEEF2', '#FF5A6E'], 'circle-stroke-opacity': ['case', ['get', 'sel'], 1, 0.4],
    });
    add('stops', 'stops', 'circle', { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 2.5, 16, 5], 'circle-color': '#0E1014', 'circle-stroke-color': '#CDD2DB', 'circle-stroke-width': 1.5 });
    add('traffic', 'traffic', 'circle', {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 2.5, 16, 6],
      'circle-color': ['interpolate', ['linear'], ['get', 'load'], 0, '#6FDCA0', 60, '#F2B84B', 90, '#FF5A6E'],
      'circle-opacity': 0.75,
      'circle-stroke-width': ['case', ['get', 'congested'], 3, 0], 'circle-stroke-color': '#FF5A6E',
    });
    add('weather', 'weather', 'circle', { 'circle-radius': 7, 'circle-color': ['case', ['get', 'rain'], '#7CA7FF', '#2B303B'], 'circle-stroke-color': '#7CA7FF', 'circle-stroke-width': 2 });
    add('air', 'air', 'circle', { 'circle-radius': 8, 'circle-color': ['get', 'colour'], 'circle-stroke-color': '#0E1014', 'circle-stroke-width': 2 });
    add('buses-halo', 'buses', 'circle', { 'circle-radius': 13, 'circle-color': ['get', 'colour'], 'circle-opacity': ['case', ['get', 'selected'], 0.45, 0.18] });
    add('buses', 'buses', 'circle', {
      'circle-radius': 8, 'circle-color': ['get', 'colour'],
      'circle-stroke-color': ['match', ['get', 'status'], 'broken', '#FF5A6E', 'stopped', '#F2B84B', '#0E1014'], 'circle-stroke-width': 3,
    });
    if (this.online) {
      add('buses-label', 'buses', 'symbol', { 'text-color': '#0E1014' }, { layout: { 'text-field': ['get', 'line'], 'text-size': 10, 'text-font': ['Noto Sans Bold'], 'text-allow-overlap': true } });
    }

    for (const [layer, kind] of [['buses', 'bus'], ['lamps', 'lamp'], ['air', 'air'], ['traffic', 'traffic'], ['weather', 'weather'], ['stops', 'stop']]) {
      this.map.on('click', layer, (ev) => { ev.preventDefault(); this.onClick(kind, ev.features[0].properties.id); });
      this.map.on('mouseenter', layer, () => { this.map.getCanvas().style.cursor = 'pointer'; });
      this.map.on('mouseleave', layer, () => { this.map.getCanvas().style.cursor = ''; });
    }
  }

  colourOf(line) {
    if (!this.lineColour.has(line)) this.lineColour.set(line, LINE_COLOURS[this.lineColour.size % LINE_COLOURS.length]);
    return this.lineColour.get(line);
  }

  //
  // draw - every layer from the world (draw(world, ['buses']) for some)
  //
  draw(world, which = null) {
    if (!this.map || !this.map.getSource('buses')) return;
    const want = (s) => which === null || which.includes(s);
    const src = (s, f) => this.map.getSource(s).setData(fc(f));

    if (want('routes')) {
      src('routes', [...world.routes.values()].map((r) => ({
        type: 'Feature', geometry: r.entity.location.value, properties: { id: r.entity.id, colour: this.colourOf(r.line) },
      })));
      src('stops', world.of('BusStop').filter(point).map((s) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: point(s) }, properties: { id: s.id } })));
    }

    if (want('lamps')) {
      src('lamps', world.of('Streetlight').filter(point).map((l) => ({
        type: 'Feature', geometry: { type: 'Point', coordinates: point(l) },
        properties: { id: l.id, state: val(l, 'status') === 'broken' ? 'broken' : (val(l, 'powerState') === 'on' ? 'on' : 'off'), sel: l.id === this.selectedLamp },
      })));
    }

    if (want('air')) {
      src('air', world.of('AirQualityObserved').filter(point).map((a) => ({
        type: 'Feature', geometry: { type: 'Point', coordinates: point(a) },
        properties: { id: a.id, colour: LEVEL_COLOURS[val(a, 'airQualityLevel')] || '#5A616E' },
      })));
      src('weather', world.of('WeatherObserved').filter(point).map((w) => ({
        type: 'Feature', geometry: { type: 'Point', coordinates: point(w) }, properties: { id: w.id, rain: (val(w, 'precipitation') || 0) > 0 },
      })));
    }

    if (want('traffic')) {
      src('traffic', world.of('TrafficFlowObserved').filter(point).map((t) => ({
        type: 'Feature', geometry: { type: 'Point', coordinates: point(t) },
        properties: { id: t.id, load: val(t, 'load') || 0, congested: val(t, 'congested') === true },
      })));
    }

    if (want('buses')) {
      src('buses', world.buses.map((b) => {
        const e = world.byId.get(b.id);
        const r = world.routes.get(b.routeId);
        return {
          type: 'Feature', geometry: { type: 'Point', coordinates: point(e) },
          properties: { id: b.id, line: r ? r.line : '', colour: this.colourOf(r ? r.line : ''), status: b.status, selected: b.id === this.selected },
        };
      }).filter((f) => f.geometry.coordinates));
    }
  }

  flyTo(coords) { if (this.map && coords) this.map.easeTo({ center: coords, zoom: Math.max(this.map.getZoom(), 15), duration: 600 }); }
}
