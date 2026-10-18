//
// main.js - CDMAD's page: start and fill the broker, run the world, the controls
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// Start broker + populate: the backend starts coraine (POST /api/broker/start); the page opens the broker's
// WebSocket and upserts the snapshot. The ckan bridge makes the air-quality stations meanwhile - when it has
// not (no network), the snapshot's stationsFallback are upserted instead.
//
// A page loaded while the broker runs ATTACHES: the world is read back from the broker (the buses where they
// are, the lamps as they are), nothing is upserted again.
//
// The world moves once a second: one batch update with every changed attribute. A control - a bus stopped,
// a lamp broken - is sent at once, not at the next second: an alarm in c³ should follow the click.
//
import { Broker } from './broker.js';
import { MapView } from './mapview.js';
import { World, no2Level, val } from './world.js';

const CENTER = [-3.6930, 40.4300];
const ZOOM = 12.6;
const STATION_WAIT_S = 20;

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const k of kids) e.append(k);
  return e;
};
const short = (id) => id.split(':').pop();

let world = null;
let broker = null;
let timer = null;
let sending = false;
const map = new MapView($('map'), { onClick });

//
// log - a line of the Log tab
//
function log(text, cls = '') {
  const t = new Date().toLocaleTimeString();
  $('log').prepend(el('li', { class: cls }, el('time', {}, t), text));
}

async function api(path, method = 'GET') {
  const r = await fetch(path, { method });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.detail || body.title || `${method} ${path}: ${r.status}`);
  return body;
}

function pill(text, cls) { $('pill').textContent = text; $('pill').className = 'pill ' + cls; }

function progress(done, total, text) {
  $('progress').hidden = total === 0;
  $('bar').style.width = total ? `${(100 * done) / total}%` : '0';
  $('progressText').textContent = text;
}

function buttons(running) {
  $('start').disabled = false;
  $('stop').disabled = !running;
  $('refresh').disabled = !running;
  $('play').disabled = !running;
}

// -----------------------------------------------------------------------------
//
// The broker
//
async function connect(url) {
  broker = new Broker(url);
  await broker.connect();
  broker.onClose = () => {
    stopLoop();
    pill('broker gone', 'off');
    buttons(false);
    log('The broker closed the WebSocket', 'err');
  };
}

async function startAll() {
  $('start').disabled = true;
  stopLoop();
  if (broker) { broker.onClose = null; broker.close(); }

  try {
    pill('starting…', 'busy');
    progress(0, 1, 'Starting the broker…');
    const state = await api('/api/broker/start', 'POST');
    log(`Broker started - pid ${state.pid}, ${state.url}`);

    const snapshot = await (await fetch('data/snapshot.json')).json();
    world = new World(snapshot);
    world.factor = +$('factor').value;
    await connect(state.url);

    // options=update: the ckan bridge may have made a station already - a replacing upsert would take its location
    const errors = await broker.batch('upsert', snapshot.entities, {
      options: 'update',
      onProgress: (n, total) => progress(n, total, `Populating - ${n} of ${total} entities`),
    });
    if (errors.length) log(`${errors.length} entities refused - first: ${JSON.stringify(errors[0]).slice(0, 200)}`, 'err');
    log(`${snapshot.entities.length - errors.length} entities upserted (Madrid of ${snapshot.generated.slice(0, 10)})`);

    await stations();
    pill('broker running', 'on');
    progress(0, 0, '');
    buttons(true);
    map.draw(world);
    render();
    startLoop();
  } catch (e) {
    pill('broker stopped', 'off');
    progress(0, 0, '');
    buttons(false);
    log(e.message, 'err');
  }
}

//
// stations - the air-quality stations, from the ckan bridge; the fallback when it made none in STATION_WAIT_S
//
async function stations() {
  const want = world.fallbackStations.length;
  for (let s = 0; s < STATION_WAIT_S; s++) {
    progress(s, STATION_WAIT_S, 'Waiting for the ckan bridge (datos.madrid.es) - the air-quality stations…');
    const got = (await broker.entities('AirQualityObserved')).filter((e) => e.location);
    if (want === 0 || got.length >= want) {
      world.apply(got);
      log(`${got.length} air-quality stations from datos.madrid.es, through the ckan bridge`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  await broker.batch('upsert', world.fallbackStations, { options: 'update' });
  world.apply(world.fallbackStations);
  log(`The ckan bridge made no stations (no network?) - ${want} upserted from the snapshot instead`, 'err');
}

//
// attach - the broker runs already: read the world back from it
//
async function attach(state) {
  const snapshot = await (await fetch('data/snapshot.json')).json();
  world = new World(snapshot);
  world.factor = +$('factor').value;
  await connect(state.url);

  const buses = await broker.entities('Bus');
  if (buses.length === 0) {
    log('The broker runs, but holds no city - Start broker + populate');
    pill('broker running (empty)', 'busy');
    buttons(true);
    return;
  }

  for (const t of ['Bus', 'Streetlight', 'AirQualityObserved', 'WeatherObserved', 'TrafficFlowObserved']) world.apply(await broker.entities(t));
  for (const b of buses) world.place(world.byId.get(b.id));
  world.night = world.of('Streetlight').some((l) => val(l, 'powerState') === 'on');
  world.raining = world.of('WeatherObserved').some((w) => (val(w, 'precipitation') || 0) > 0);
  $('night').checked = world.night;
  $('rain').checked = world.raining;

  pill('broker running', 'on');
  buttons(true);
  map.draw(world);
  render();
  startLoop();
  log(`Attached to the running broker (pid ${state.pid}) - the world as it is`);
}

async function stopAll() {
  stopLoop();
  if (broker) { broker.onClose = null; broker.close(); broker = null; }
  await api('/api/broker/stop', 'POST').catch((e) => log(e.message, 'err'));
  pill('broker stopped', 'off');
  buttons(false);
  log('Broker stopped');
}

async function refresh() {
  $('refresh').disabled = true;
  progress(0, 1, 'Reading today\'s Madrid - air quality, weather, traffic…');
  try {
    const live = await api('/api/refresh', 'POST');
    world.apply(live.entities);
    const errors = await broker.batch('upsert', live.entities, { options: 'update' });
    log(`Madrid refreshed - ${live.entities.length} readings of ${live.generated}` + (errors.length ? `, ${errors.length} refused` : ''));
    map.draw(world);
    render();
  } catch (e) {
    log(`No refresh: ${e.message}`, 'err');
  }
  progress(0, 0, '');
  $('refresh').disabled = false;
}

// -----------------------------------------------------------------------------
//
// The loop - a second of the world, its changes to the broker
//
function startLoop() {
  stopLoop();
  world.running = true;
  $('play').textContent = '⏸ Pause';
  timer = setInterval(() => { world.tick(1); send(); map.draw(world, ['buses']); tickPanels(); }, 1000);
}

function stopLoop() { if (timer) clearInterval(timer); timer = null; }

async function send() {
  if (!broker || !broker.open || sending) return;
  const frags = world.flush();
  if (frags.length === 0) return;

  sending = true;
  try {
    const errors = await broker.batch('update', frags);
    if (errors.length) log(`update refused: ${JSON.stringify(errors[0]).slice(0, 200)}`, 'err');
  } catch (e) {
    log(e.message, 'err');
  }
  sending = false;
}

//
// now - a control's change: sent and drawn at once
//
function now(what) {
  send();
  map.draw(world);
  render();
  if (what) log(what.text, what.alert ? 'alert' : '');
}

// -----------------------------------------------------------------------------
//
// The panels
//
function render() {
  if (!world) return;
  renderBuses();
  renderLamps();
  renderAir();
  renderTraffic();
}

function lineBadge(routeId) {
  const r = world.routes.get(routeId);
  const line = r ? r.line : '?';
  return el('span', { class: 'badge', style: `background:${map.colourOf(line)}` }, line);
}

function renderBuses() {
  const box = $('tab-buses');
  box.replaceChildren();

  for (const b of world.buses) {
    const e = world.byId.get(b.id);
    const driver = world.byId.get(val(e, 'drivenBy'));
    const speed = el('input', { type: 'range', min: 0, max: 80, value: Math.round(b.setKmh) });
    const v = el('span', { class: 'v' }, `${Math.round(b.setKmh)} km/h`);
    speed.addEventListener('input', () => { world.busSpeed(b.id, +speed.value); v.textContent = `${speed.value} km/h`; });
    speed.addEventListener('change', () => log(`Bus ${short(b.id)}: ${speed.value} km/h`));

    const stopGo = el('button', { onclick: () => {
      const s = b.status === 'stopped' ? 'inService' : 'stopped';
      world.busStatus(b.id, s);
      now({ text: `Bus ${short(b.id)} ${s === 'stopped' ? 'stopped by the driver' : 'goes on'}` });
    } }, b.status === 'stopped' ? 'Go' : 'Stop');
    const breakFix = el('button', { class: b.status === 'broken' ? '' : 'danger', onclick: () => {
      const s = b.status === 'broken' ? 'inService' : 'broken';
      world.busStatus(b.id, s);
      now({ text: s === 'broken' ? `Bus ${short(b.id)} BROKEN DOWN - an alarm in c³` : `Bus ${short(b.id)} repaired`, alert: s === 'broken' });
    } }, b.status === 'broken' ? 'Repair' : 'Break');

    const row = el('div', { class: 'row' + (map.selected === b.id ? ' sel' : ''), id: 'bus-' + short(b.id) },
      el('div', { class: 'head', onclick: () => select(b.id) },
        lineBadge(b.routeId), el('span', { class: 'name' }, `Bus ${short(b.id)}`),
        el('span', { class: 'chip ' + b.status, 'data-status': '' }, b.status)),
      el('div', { class: 'sub', 'data-sub': '' }, subText(b, driver)),
      el('div', { class: 'ctl' }, speed, v, stopGo, breakFix));
    box.append(row);
  }
}

function subText(b, driver) {
  const e = world.byId.get(b.id);
  const next = world.byId.get(val(e, 'nextStop'));
  return `${driver ? val(driver, 'name') : ''} · ${Math.round(b.kmh)} km/h · ${b.occupancy} % full` + (next ? ` · next: ${val(next, 'name')}` : '');
}

//
// tickPanels - the moving numbers of the bus rows, without rebuilding them (a slider being dragged stays)
//
function tickPanels() {
  for (const b of world.buses) {
    const row = $('bus-' + short(b.id));
    if (!row) continue;
    const e = world.byId.get(b.id);
    const chip = row.querySelector('[data-status]');
    chip.textContent = b.status;
    chip.className = 'chip ' + b.status;
    row.querySelector('[data-sub]').textContent = subText(b, world.byId.get(val(e, 'drivenBy')));
    const badge = row.querySelector('.badge');
    const r = world.routes.get(b.routeId);
    if (r && badge.textContent !== r.line) badge.replaceWith(lineBadge(b.routeId));
  }
}

function renderLamps() {
  const lamps = world.of('Streetlight');
  const broken = lamps.filter((l) => val(l, 'status') === 'broken');
  const on = lamps.filter((l) => val(l, 'powerState') === 'on');
  const box = $('tab-lamps');

  box.replaceChildren(
    el('div', { class: 'stat' }, el('span', {}, el('b', {}, String(lamps.length)), 'streetlights'), el('span', {}, el('b', {}, String(on.length)), 'on'), el('span', {}, el('b', {}, String(broken.length)), 'broken')),
    el('div', { class: 'hint' }, 'Click a streetlight on the map to break it - or to repair a broken one. Real lamps: the city\'s inventory, along lines 27 and 2.'),
    el('div', { class: 'btns' },
      el('button', { class: 'danger', onclick: () => {
        const ok = lamps.filter((l) => val(l, 'status') !== 'broken');
        if (ok.length) lampToggle(ok[Math.floor(Math.random() * ok.length)].id);
      } }, 'Break a random one'),
      el('button', { onclick: () => { for (const l of broken) world.lampStatus(l.id, 'ok'); now({ text: `${broken.length} streetlights repaired` }); }, disabled: broken.length ? null : '' }, 'Repair all')),
    el('h4', {}, 'Broken'),
    ...broken.map((l) => el('div', { class: 'row' },
      el('div', { class: 'head', onclick: () => map.flyTo(l.location.value.coordinates) },
        el('span', { class: 'name' }, lampName(l)), el('span', { class: 'chip broken' }, 'broken'),
        el('button', { onclick: (ev) => { ev.stopPropagation(); lampToggle(l.id); } }, 'Repair')))));
  if (!broken.length) box.querySelector('.btns').nextSibling.after(el('div', { class: 'hint' }, 'None.'));
}

function lampName(l) {
  const a = val(l, 'address');
  return (a && a.streetAddress) || short(l.id);
}

function lampToggle(id) {
  const l = world.byId.get(id);
  const broken = val(l, 'status') === 'broken';
  world.lampStatus(id, broken ? 'ok' : 'broken');
  now({ text: broken ? `Streetlight ${lampName(l)} repaired` : `Streetlight ${lampName(l)} BROKEN - an alarm in c³`, alert: !broken });
}

function renderAir() {
  const box = $('tab-air');
  const stationsList = world.of('AirQualityObserved').filter((a) => a.location).sort((a, b) => (val(b, 'NO2') || 0) - (val(a, 'NO2') || 0));
  const weather = world.of('WeatherObserved').filter((w) => val(w, 'temperature') !== undefined);
  const t = weather.map((w) => val(w, 'temperature'));
  const avgT = t.length ? (t.reduce((a, b) => a + b, 0) / t.length).toFixed(1) : '-';

  box.replaceChildren(
    el('div', { class: 'stat' }, el('span', {}, el('b', {}, `${avgT} °C`), 'average, ' + weather.length + ' weather stations'), el('span', {}, el('b', {}, world.raining ? 'raining' : 'dry'), 'Rain: the toggle above')),
    el('div', { class: 'hint' }, 'NO₂ over 200 µg/m³ - the EU hourly limit - raises an alarm in c³.'),
    el('h4', {}, 'Air quality - NO₂, µg/m³'),
    ...stationsList.map((a) => {
      const no2 = Math.round(val(a, 'NO2') || 0);
      const s = el('input', { type: 'range', min: 0, max: 400, value: no2 });
      const v = el('span', { class: 'v' }, String(no2));
      const chip = el('span', { class: 'chip ' + (val(a, 'airQualityLevel') || '') }, val(a, 'airQualityLevel') || 'no reading');
      s.addEventListener('input', () => { v.textContent = s.value; const lv = no2Level(+s.value); chip.textContent = lv; chip.className = 'chip ' + lv; });
      s.addEventListener('change', () => {
        world.setNo2(a.id, +s.value);
        now({ text: `${val(a, 'name')}: NO₂ ${s.value} µg/m³` + (+s.value > 200 ? ' - over the EU limit, an alarm in c³' : ''), alert: +s.value > 200 });
      });
      return el('div', { class: 'row', id: 'air-' + short(a.id) },
        el('div', { class: 'head', onclick: () => map.flyTo(a.location.value.coordinates) }, el('span', { class: 'name' }, val(a, 'name') || short(a.id)), chip),
        el('div', { class: 'ctl' }, s, v));
    }));
}

function renderTraffic() {
  const sensors = world.of('TrafficFlowObserved');
  const jams = sensors.filter((t) => val(t, 'congested') === true);
  const box = $('tab-traffic');

  box.replaceChildren(
    el('div', { class: 'stat' }, el('span', {}, el('b', {}, String(sensors.length)), 'sensors (real, informo.madrid.es)'), el('span', {}, el('b', {}, String(jams.length)), 'congested')),
    el('div', { class: 'hint' }, 'Click a sensor on the map to jam it: buses within 150 m crawl. A jam raises an alarm in c³.'),
    el('div', { class: 'btns' },
      el('button', { class: 'danger', onclick: rushHour }, 'Rush hour on the Castellana'),
      el('button', { onclick: () => { for (const t of jams) world.setJam(t.id, false); now({ text: `${jams.length} jams cleared` }); }, disabled: jams.length ? null : '' }, 'Clear all')),
    el('h4', {}, 'Congested'),
    ...jams.map((t) => el('div', { class: 'row' },
      el('div', { class: 'head', onclick: () => map.flyTo(t.location.value.coordinates) },
        el('span', { class: 'name' }, val(t, 'name') || short(t.id)), el('span', { class: 'chip jam' }, 'jam'),
        el('button', { onclick: (ev) => { ev.stopPropagation(); world.setJam(t.id, false); now({ text: `Jam cleared: ${val(t, 'name')}` }); } }, 'Clear')))));
}

//
// rushHour - the sensors on line 27's middle third jammed
//
function rushHour() {
  const r = [...world.routes.values()].find((x) => x.line === '27');
  if (!r) return;
  let n = 0;
  for (const t of world.of('TrafficFlowObserved')) {
    const p = t.location && t.location.value && t.location.value.coordinates;
    if (!p) continue;
    const { d, off } = r.route.project(p);
    if (off < 60 && d > r.route.length / 3 && d < (2 * r.route.length) / 3) { world.setJam(t.id, true); n++; }
  }
  now({ text: `Rush hour: ${n} sensors along the Castellana congested`, alert: true });
}

// -----------------------------------------------------------------------------
//
// The map's clicks, the tabs, selection
//
function onClick(kind, id) {
  if (!world) return;
  if (kind === 'lamp') lampToggle(id);
  else if (kind === 'traffic') {
    const t = world.byId.get(id);
    const jam = val(t, 'congested') !== true;
    world.setJam(id, jam);
    now({ text: jam ? `Traffic jam at ${val(t, 'name')} - an alarm in c³` : `Jam cleared: ${val(t, 'name')}`, alert: jam });
  }
  else if (kind === 'bus') { tab('buses'); select(id); }
  else if (kind === 'air') { tab('air'); const row = $('air-' + short(id)); if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  else if (kind === 'weather') {
    const w = world.byId.get(id);
    log(`${val(w, 'name')}: ${val(w, 'temperature') ?? '-'} °C, ${val(w, 'relativeHumidity') ?? '-'} %, ${val(w, 'precipitation') ?? 0} mm/h`);
  }
  else if (kind === 'stop') log(`Stop ${val(world.byId.get(id), 'name')}`);
}

function select(id) {
  map.selected = id;
  map.draw(world, ['buses']);
  map.flyTo(world.byId.get(id).location.value.coordinates);
  renderBuses();
  const row = $('bus-' + short(id));
  if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function tab(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('on', b.dataset.tab === name);
  for (const s of document.querySelectorAll('.tab')) s.hidden = s.id !== 'tab-' + name;
}

// -----------------------------------------------------------------------------
//
// Start
//
$('start').onclick = startAll;
$('stop').onclick = stopAll;
$('refresh').onclick = refresh;
$('play').onclick = () => {
  world.running = !world.running;
  $('play').textContent = world.running ? '⏸ Pause' : '▶ Play';
  log(world.running ? 'The world moves again' : 'The world paused');
};
$('factor').onchange = () => { if (world) world.factor = +$('factor').value; };
$('night').onchange = () => { world.setNight($('night').checked); now({ text: $('night').checked ? 'Night: the streetlights go on' : 'Day: the streetlights go off' }); };
$('rain').onchange = () => { world.setRain($('rain').checked); now({ text: $('rain').checked ? 'Rain: the buses slow down (−20 %)' : 'The rain stops' }); };
for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => tab(b.dataset.tab);

buttons(false);
$('start').disabled = true;                      // until the map is there and a running broker is attached
await map.init(CENTER, ZOOM);
if (!map.online) log('No network: the map has no streets - the demo\'s own data is drawn on a plain background');

try {
  const state = await api('/api/broker');
  if (state.running) await attach(state);
} catch (e) {
  log(e.message, 'err');
}
$('start').disabled = false;
