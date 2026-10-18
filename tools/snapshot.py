#!/usr/bin/env python3
#
# FILE            snapshot.py
#
# Copyright 2026 Seamware
# SPDX-License-Identifier: Apache-2.0
#
# The Madrid of the demo, from the city's open data - see doc/data.md
#
#   python3 -I tools/snapshot.py           data/snapshot.json, data/bridges.json (the whole city)
#   python3 -I tools/snapshot.py --live    data/live.json (today's air quality, weather and traffic only)
#   --offline                              use what is in data/cache/, download nothing
#
# Standard library only. Downloads are kept in data/cache/ and read as untrusted data: every value is
# converted (float/int) or used as text, nothing is evaluated.
#
import csv
import io
import json
import math
import os
import ssl
import sys
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

ROOT  = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA  = os.path.join(ROOT, "data")
CACHE = os.path.join(DATA, "cache")
MADRID_TZ = ZoneInfo("Europe/Madrid")

SOURCES = {
    "emt.zip":       "https://servicios.emtmadrid.es:8443/gtfs/transitemt.zip",
    "farolas.csv":   "https://datos.madrid.es/dataset/300573-0-unidades-luminosas-farolas/resource/300573-0-unidades-luminosas-farolas-csv/download/300573-0-unidades-luminosas-farolas-csv.csv",
    "meteo_est.csv": "https://datos.madrid.es/dataset/300360-0-meteorologicos-estaciones/resource/300360-1-meteorologicos-estaciones-csv/download/300360-1-meteorologicos-estaciones-csv.csv",
    "meteo.json":    "https://ciudadesabiertas.madrid.es/dynamicAPI/API/query/meteo_tiemporeal.json?pageSize=5000",
    "aq.json":       "https://ciudadesabiertas.madrid.es/dynamicAPI/API/query/calair_tiemporeal.json?pageSize=5000",
    "pm.xml":        "https://informo.madrid.es/informo/tmadrid/pm.xml",
    "aq_est.json":   "https://datos.madrid.es/api/3/action/datastore_search?resource_id=212629-0-estaciones-control-aire-csv&limit=100",
}
LIVE = ("meteo.json", "aq.json", "pm.xml")      # fetched again for --live

LINES = [("027", 6), ("002", 4)]                 # route_id, buses (half each direction)
MAX_SHAPE_POINTS = 300
LAMP_MAX_DIST = 25.0                             # m from a line's shape
LAMP_SPACING = 40.0                              # at most one lamp per this many m of route
TRAFFIC_MAX_DIST = 300.0
TRAFFIC_MAX = 300

AQ_RESOURCE = "212629-0-estaciones-control-aire-csv"


# -----------------------------------------------------------------------------
# Downloads
#
def fetch(name, force=False, offline=False):
    path = os.path.join(CACHE, name)
    if os.path.exists(path) and (offline or not force):
        return path
    if offline:
        sys.exit(f"snapshot: {name} not in {CACHE} and --offline")
    os.makedirs(CACHE, exist_ok=True)
    url = SOURCES[name]
    print(f"snapshot: downloading {url}", file=sys.stderr)
    req = urllib.request.Request(url, headers={"User-Agent": "c3-demo-madrid snapshot"})
    with urllib.request.urlopen(req, timeout=180, context=ssl.create_default_context()) as r:
        body = r.read()
    with open(path + ".part", "wb") as f:
        f.write(body)
    os.replace(path + ".part", path)
    return path


# -----------------------------------------------------------------------------
# Geometry - UTM ETRS89 zone 30N to lon/lat, and a local metric plane around Madrid
#
def utm_to_lonlat(x, y, zone=30):
    a = 6378137.0
    f = 1 / 298.257222101                        # GRS80 (ETRS89)
    k0 = 0.9996
    e2 = f * (2 - f)
    ep2 = e2 / (1 - e2)
    x -= 500000.0
    m = y / k0
    mu = m / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256))
    e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
    phi1 = (mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * math.sin(2 * mu)
               + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * math.sin(4 * mu)
               + (151 * e1 ** 3 / 96) * math.sin(6 * mu)
               + (1097 * e1 ** 4 / 512) * math.sin(8 * mu))
    n1 = a / math.sqrt(1 - e2 * math.sin(phi1) ** 2)
    t1 = math.tan(phi1) ** 2
    c1 = ep2 * math.cos(phi1) ** 2
    r1 = a * (1 - e2) / (1 - e2 * math.sin(phi1) ** 2) ** 1.5
    d = x / (n1 * k0)
    lat = phi1 - (n1 * math.tan(phi1) / r1) * (d ** 2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep2) * d ** 4 / 24
                                              + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep2 - 3 * c1 ** 2) * d ** 6 / 720)
    lon = (d - (1 + 2 * t1 + c1) * d ** 3 / 6 + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep2 + 24 * t1 ** 2) * d ** 5 / 120) / math.cos(phi1)
    lon0 = math.radians((zone - 1) * 6 - 180 + 3)
    return math.degrees(lon0 + lon), math.degrees(lat)


R = 6371008.8
LAT0 = math.radians(40.42)


def xy(p):                                       # lon/lat -> metres on a plane around Madrid
    return (math.radians(p[0]) * R * math.cos(LAT0), math.radians(p[1]) * R)


def dist(a, b):
    ax, ay = xy(a)
    bx, by = xy(b)
    return math.hypot(ax - bx, ay - by)


def simplify(points, tol):                       # Douglas-Peucker, on the metric plane
    pts = [xy(p) for p in points]
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        i, j = stack.pop()
        (x1, y1), (x2, y2) = pts[i], pts[j]
        dx, dy = x2 - x1, y2 - y1
        L = math.hypot(dx, dy)
        best, bi = 0.0, -1
        for k in range(i + 1, j):
            px, py = pts[k]
            d = abs(dy * px - dx * py + x2 * y1 - y2 * x1) / L if L else math.hypot(px - x1, py - y1)
            if d > best:
                best, bi = d, k
        if best > tol:
            keep[bi] = True
            stack += [(i, bi), (bi, j)]
    return [p for p, k in zip(points, keep) if k]


class Polyline:
    def __init__(self, coords):
        self.coords = coords
        self.xy = [xy(p) for p in coords]
        self.cum = [0.0]
        for a, b in zip(self.xy, self.xy[1:]):
            self.cum.append(self.cum[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
        xs = [p[0] for p in self.xy]
        ys = [p[1] for p in self.xy]
        self.box = (min(xs), min(ys), max(xs), max(ys))

    @property
    def length(self):
        return self.cum[-1]

    def project(self, p):                        # (distance from the line, distance along it)
        px, py = xy(p)
        best = (float("inf"), 0.0)
        for i, (a, b) in enumerate(zip(self.xy, self.xy[1:])):
            dx, dy = b[0] - a[0], b[1] - a[1]
            L2 = dx * dx + dy * dy
            t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - a[0]) * dx + (py - a[1]) * dy) / L2))
            qx, qy = a[0] + t * dx, a[1] + t * dy
            d = math.hypot(px - qx, py - qy)
            if d < best[0]:
                best = (d, self.cum[i] + t * math.sqrt(L2))
        return best

    def near_box(self, p, margin):
        px, py = xy(p)
        return self.box[0] - margin <= px <= self.box[2] + margin and self.box[1] - margin <= py <= self.box[3] + margin

    def at(self, s):                             # the point at distance s along it, and the bearing there
        s = max(0.0, min(self.length, s))
        for i in range(len(self.cum) - 1):
            if self.cum[i + 1] >= s:
                seg = self.cum[i + 1] - self.cum[i]
                t = 0.0 if seg == 0 else (s - self.cum[i]) / seg
                a, b = self.coords[i], self.coords[i + 1]
                p = [round(a[0] + t * (b[0] - a[0]), 6), round(a[1] + t * (b[1] - a[1]), 6)]
                ax, ay = self.xy[i]
                bx, by = self.xy[i + 1]
                bearing = (math.degrees(math.atan2(bx - ax, by - ay)) + 360) % 360
                return p, round(bearing)
        return list(self.coords[-1]), 0


# -----------------------------------------------------------------------------
# NGSI-LD helpers
#
def prop(value, **extra):
    return {"type": "Property", "value": value, **extra}


def geo(geometry):
    return {"type": "GeoProperty", "value": geometry}


def rel(urn):
    return {"type": "Relationship", "object": urn}


def num(s):
    return float(str(s).strip().replace(",", "."))


def madrid_time(y, m, d, hour=0, minute=0, second=0):   # local Madrid time -> UTC ISO 8601
    if hour == 24:                                       # H24 = the hour ending at midnight
        t = datetime(int(y), int(m), int(d), 23, 59, 59, tzinfo=MADRID_TZ)
    else:
        t = datetime(int(y), int(m), int(d), hour, minute, second, tzinfo=MADRID_TZ)
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# -----------------------------------------------------------------------------
# The air-quality level - the EEA European Air Quality Index bands (µg/m³), six levels collapsed to four:
# good+fair = good, moderate, poor, veryPoor+extremelyPoor = veryPoor; the worst pollutant decides
#
AQ_BANDS = {                       # upper bounds of good, fair, moderate, poor, very poor
    "NO2":  [40, 90, 120, 230, 340],
    "PM10": [20, 40, 50, 100, 150],
    "O3":   [50, 100, 130, 240, 380],
}
AQ_LEVELS = ["good", "good", "moderate", "poor", "veryPoor", "veryPoor"]


def aq_level(values):
    worst = 0
    for k, v in values.items():
        bands = AQ_BANDS.get(k)
        if bands is None or v is None:
            continue
        lvl = next((i for i, ub in enumerate(bands) if v <= ub), 5)
        worst = max(worst, lvl)
    return AQ_LEVELS[worst]


# -----------------------------------------------------------------------------
# Hourly readings (air quality, weather): the latest valid hour of each station and magnitude
#
def latest_hourly(path, magnitudes):
    out = {}                                     # station code -> {name: (value, observedAt)}
    for r in json.load(open(path, encoding="utf-8"))["records"]:
        mag = str(r.get("MAGNITUD", "")).lstrip("0")
        if mag not in magnitudes:
            continue
        code = str(r["PROVINCIA"]) + str(r["MUNICIPIO"]).zfill(3) + str(r["ESTACION"]).zfill(3)
        for h in range(24, 0, -1):
            v, ok = r.get(f"H{h:02d}"), r.get(f"V{h:02d}")
            if ok == "V" and v not in (None, ""):
                try:
                    val = num(v)
                except ValueError:
                    continue
                out.setdefault(code, {})[magnitudes[mag]] = (val, madrid_time(r["ANO"], r["MES"], r["DIA"], h))
                break
    return out


AQ_MAGS = {"8": "NO2", "10": "PM10", "14": "O3"}
METEO_MAGS = {"81": "windSpeed", "83": "temperature", "86": "relativeHumidity", "89": "precipitation"}
METEO_UNITS = {"windSpeed": "MTS", "temperature": "CEL", "relativeHumidity": "P1", "precipitation": "H67"}   # UN/CEFACT; H67 = mm/h


def aq_fragments(path):
    ents = []
    for code, vals in sorted(latest_hourly(path, AQ_MAGS).items()):
        e = {"id": f"urn:ngsi-ld:AirQualityObserved:{code}", "type": "AirQualityObserved"}
        newest = None
        for name, (v, t) in vals.items():
            e[name] = prop(v, unitCode="GQ", observedAt=t)
            newest = max(newest or t, t)
        e["airQualityLevel"] = prop(aq_level({k: v for k, (v, _) in vals.items()}), observedAt=newest)
        ents.append(e)
    return ents


def weather_readings(path):
    return latest_hourly(path, METEO_MAGS)


def weather_fragment(code, vals):
    e = {"id": f"urn:ngsi-ld:WeatherObserved:{code}", "type": "WeatherObserved"}
    for name, (v, t) in sorted(vals.items()):
        e[name] = prop(v, unitCode=METEO_UNITS[name], observedAt=t)
    return e


# -----------------------------------------------------------------------------
# Traffic - pm.xml: UTM coordinates with a decimal comma; nivelServicio 0 fluid, 1 slow, 2 queues, 3 congestion
#
def traffic_points(path):
    root = ET.parse(path).getroot()
    stamp = root.findtext("fecha_hora", "").strip()          # "18/10/2026 8:15:01", Madrid time
    try:
        d, t = stamp.split(" ")
        dd, mm, yy = d.split("/")
        hh, mi, ss = t.split(":")
        observed = madrid_time(yy, mm, dd, int(hh), int(mi), int(ss))
    except ValueError:
        observed = None
    pts = []
    for pm in root.iter("pm"):
        try:
            if (pm.findtext("error") or "").strip() != "N":
                continue
            x, y = num(pm.findtext("st_x")), num(pm.findtext("st_y"))
            pts.append({
                "id": (pm.findtext("idelem") or "").strip(),
                "name": (pm.findtext("descripcion") or "").strip(),
                "lonlat": [round(v, 6) for v in utm_to_lonlat(x, y)],
                "intensity": int(num(pm.findtext("intensidad"))),
                "occupancy": int(num(pm.findtext("ocupacion"))),
                "load": int(num(pm.findtext("carga"))),
                "level": int(num(pm.findtext("nivelServicio"))),
            })
        except (TypeError, ValueError):
            continue
    return [p for p in pts if p["id"] and p["load"] >= 0], observed


def traffic_fragment(p, observed, full):
    e = {"id": f"urn:ngsi-ld:TrafficFlowObserved:{p['id']}", "type": "TrafficFlowObserved"}
    o = {"observedAt": observed} if observed else {}
    if full:
        e["name"] = prop(p["name"])
        e["location"] = geo({"type": "Point", "coordinates": p["lonlat"]})
    e["intensity"] = prop(p["intensity"], unitCode="E50", **o)          # vehicles/h
    e["occupancy"] = prop(p["occupancy"], unitCode="P1", **o)
    e["load"] = prop(p["load"], **o)
    e["congested"] = prop(p["level"] >= 2, **o)                         # queues or congestion
    return e


# -----------------------------------------------------------------------------
# The bus lines - EMT GTFS
#
def read_gtfs(path):
    z = zipfile.ZipFile(path)

    def rows(name):
        return csv.DictReader(io.TextIOWrapper(z.open(name), encoding="utf-8-sig"))

    wanted = {r for r, _ in LINES}
    routes = {r["route_id"]: r for r in rows("routes.txt") if r["route_id"] in wanted}
    trips = {}                                   # trip_id -> trip, of the wanted routes
    for t in rows("trips.txt"):
        if t["route_id"] in wanted:
            trips[t["trip_id"]] = t
    shapes = {}
    for s in rows("shapes.txt"):
        if s["shape_id"][:3] in wanted:
            shapes.setdefault(s["shape_id"], []).append((int(s["shape_pt_sequence"]), [float(s["shape_pt_lon"]), float(s["shape_pt_lat"])]))
    stoptimes = {}                               # trip_id -> [(seq, stop_id)]
    for st in rows("stop_times.txt"):
        if st["trip_id"] in trips:
            stoptimes.setdefault(st["trip_id"], []).append((int(st["stop_sequence"]), st["stop_id"]))
    stops = {s["stop_id"]: s for s in rows("stops.txt")}
    return routes, trips, {k: [p for _, p in sorted(v)] for k, v in shapes.items()}, stoptimes, stops


DRIVERS = ["Lucía Fernández Ortega", "Javier Moreno Castillo", "Carmen Ruiz Delgado", "Alberto Navarro Gil",
           "Marta Jiménez Herrero", "Sergio Romero Vidal", "Pilar Domínguez Rubio", "Raúl Serrano Molina",
           "Elena Blanco Prieto", "Diego Márquez Soto"]
PLATES = ["4821 LKB", "5307 LMC", "6194 LNF", "7032 LPG", "8156 LRH", "9248 LSJ", "3769 LTK", "2415 LVM",
          "1683 LWN", "5940 LXP"]
MODELS = ["Irizar ie tram", "Mercedes-Benz eCitaro", "Solaris Urbino 12 electric"]


def bus_lines():
    routes, trips, shapes, stoptimes, stops = read_gtfs(fetch("emt.zip"))
    ents_stops, ents_routes, polylines, plan = {}, [], {}, []
    for rid, nbus in LINES:
        r = routes[rid]
        ends = [p.strip() for p in r["route_long_name"].split(" - ")]
        for direction, suffix in (("0", "A"), ("1", "B")):
            sid = f"{rid}_{suffix}"
            cand = [t for t in trips.values() if t["shape_id"] == sid and t["direction_id"] == direction]
            trip = max(cand, key=lambda t: len(stoptimes.get(t["trip_id"], [])))
            stop_ids = [s for _, s in sorted(stoptimes[trip["trip_id"]])]
            raw = shapes[sid]
            tol, simp = 1.0, raw
            while len(simp) > MAX_SHAPE_POINTS:
                simp = simplify(raw, tol)
                tol *= 1.5
            simp = [[round(p[0], 6), round(p[1], 6)] for p in simp]
            line = Polyline(simp)
            polylines[sid] = line
            frm, to = (ends[0], ends[1]) if direction == "0" else (ends[1], ends[0])
            urn = f"urn:ngsi-ld:PublicTransportRoute:EMT-{rid}-{suffix}"
            stop_urns, stop_dists = [], []
            for s in stop_ids:
                st = stops[s]
                surn = f"urn:ngsi-ld:BusStop:EMT-{s}"
                p = [float(st["stop_lon"]), float(st["stop_lat"])]
                ents_stops.setdefault(surn, {"id": surn, "type": "BusStop", "name": prop(st["stop_name"]),
                                             "stopCode": prop(st["stop_code"]), "location": geo({"type": "Point", "coordinates": p})})
                stop_urns.append(surn)
                stop_dists.append(round(line.project(p)[1]))
            ents_routes.append({
                "id": urn, "type": "PublicTransportRoute",
                "name": prop(f"{r['route_short_name']} {frm} → {to}"),
                "routeShortName": prop(r["route_short_name"]),
                "routeColor": prop("#" + r["route_color"]),
                "length": prop(round(line.length), unitCode="MTR"),
                "location": geo({"type": "LineString", "coordinates": simp}),
                "hasStop": {"type": "ListRelationship", "objectList": stop_urns},
                "stopDistances": prop(stop_dists, unitCode="MTR"),
            })
            n = nbus // 2
            for i in range(n):
                plan.append((urn, line, stop_urns, stop_dists, (i + 0.5) / n * line.length))
    persons, buses = [], []
    for i, (urn, line, stop_urns, stop_dists, s) in enumerate(plan):
        purn = f"urn:ngsi-ld:Person:driver-{i + 1}"
        persons.append({"id": purn, "type": "Person", "name": prop(DRIVERS[i]), "employeeNumber": prop(f"E{40217 + i * 37}")})
        p, bearing = line.at(s)
        nxt = next((u for u, d in zip(stop_urns, stop_dists) if d > s), stop_urns[-1])
        fleet = 8701 + i
        buses.append({
            "id": f"urn:ngsi-ld:Bus:EMT-{fleet}", "type": "Bus",
            "location": geo({"type": "Point", "coordinates": p}),
            "speed": prop(20 + (i * 7) % 11, unitCode="KMH"),
            "bearing": prop(bearing),
            "status": prop("inService"),
            "occupancy": prop(15 + (i * 23) % 60, unitCode="P1"),
            "licensePlate": prop(PLATES[i]),
            "vehicleModel": prop(MODELS[i % len(MODELS)]),
            "onRoute": rel(urn),
            "nextStop": rel(nxt),
            "drivenBy": rel(purn),
        })
    return persons, list(ents_stops.values()), ents_routes, buses, polylines


# -----------------------------------------------------------------------------
# Streetlights - the city's lamps near the two lines
#
def streetlights(polylines):
    best = {}                                    # (shape, 40-m bin) -> (distance, entity)
    seen = set()
    with open(fetch("farolas.csv"), encoding="utf-8-sig", newline="") as f:
        rd = csv.reader(f, delimiter=";")
        header = [h.split(",")[0] for h in next(rd)]
        col = {h: i for i, h in enumerate(header)}
        for row in rd:
            try:
                x, y = num(row[col["X_UTM"]]), num(row[col["Y_UTM"]])
            except (ValueError, IndexError):
                continue
            p = utm_to_lonlat(x, y)
            for sid, line in polylines.items():
                if not line.near_box(p, LAMP_MAX_DIST):
                    continue
                d, along = line.project(p)
                if d > LAMP_MAX_DIST:
                    continue
                key = (sid[:3], int(along // LAMP_SPACING))          # per line: both directions share streets
                if key in best and best[key][0] <= d:
                    continue
                lid = f"MAD-{round(x)}-{round(y)}"
                street = " ".join(row[col[c]].strip() for c in ("VIA_CLASE", "VIA_PAR", "VIA_NOMBRE") if row[col[c]].strip())
                number = row[col["NUMERO"]].strip()
                best[key] = (d, {
                    "id": f"urn:ngsi-ld:Streetlight:{lid}", "type": "Streetlight",
                    "location": geo({"type": "Point", "coordinates": [round(p[0], 6), round(p[1], 6)]}),
                    "status": prop("ok"),
                    "powerState": prop("off"),
                    "lampType": prop(row[col["TIPOL"]].strip()),
                    "address": prop({"streetAddress": f"{street} {number}".strip(), "addressLocality": "Madrid"}),
                })
    out = []
    for _, e in sorted(best.values(), key=lambda v: v[1]["id"]):
        if e["id"] not in seen:                  # one lamp may be the best of two bins
            seen.add(e["id"])
            out.append(e)
    return out


# -----------------------------------------------------------------------------
# Weather stations - their locations, and the latest readings
#
def weather(full=True):
    readings = weather_readings(fetch("meteo.json", force=not full))
    if not full:
        return [weather_fragment(c, v) for c, v in sorted(readings.items())]
    ents = []
    with open(fetch("meteo_est.csv"), encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f, delimiter=";"):
            code = r["CÓDIGO"].strip()
            try:
                p = [round(num(r["LONGITUD"]), 6), round(num(r["LATITUD"]), 6)]
            except ValueError:
                continue
            e = {"id": f"urn:ngsi-ld:WeatherObserved:{code}", "type": "WeatherObserved",
                 "name": prop(r["ESTACION"].strip()), "location": geo({"type": "Point", "coordinates": p})}
            if code in readings:
                e.update({k: v for k, v in weather_fragment(code, readings[code]).items() if k not in ("id", "type")})
            ents.append(e)
    return ents


def traffic(polylines, full=True, ids=None):
    pts, observed = traffic_points(fetch("pm.xml", force=not full))
    if not full:
        return [traffic_fragment(p, observed, False) for p in pts if f"urn:ngsi-ld:TrafficFlowObserved:{p['id']}" in ids]
    near = []
    for p in pts:
        d = min((line.project(p["lonlat"])[0] for line in polylines.values() if line.near_box(p["lonlat"], TRAFFIC_MAX_DIST)), default=float("inf"))
        if d <= TRAFFIC_MAX_DIST:
            near.append((d, p))
    near.sort(key=lambda v: (v[0], v[1]["id"]))
    return [traffic_fragment(p, observed, True) for _, p in near[:TRAFFIC_MAX]]


def bridges():
    return {"ckan": {
        "server": {"url": "https://datos.madrid.es", "timeoutMs": 30000},
        "ngsild": {
            "defaultEntity": False,
            "dataChannels": {AQ_RESOURCE: {
                "channelInfo": [{"key": "mode", "value": "once"}, {"key": "pageSize", "value": "100"}],
                "entities": [{
                    "type": "AirQualityObserved", "id": "urn:ngsi-ld:AirQualityObserved:{CODIGO}",
                    "attributes": {
                        "name": {"column": "ESTACION"},
                        "stationType": {"column": "NOM_TIPO"},
                        "location": {"point": {"longitude": "LONGITUD", "latitude": "LATITUD"}}}}]}}}}}


#
# stationsFallback - the air-quality stations as the ckan bridge makes them (bridges.json), for a broker that
# cannot reach datos.madrid.es: the page upserts them only when the bridge has not
#
def stations_fallback():
    ents = []
    for r in json.load(open(fetch("aq_est.json"), encoding="utf-8"))["result"]["records"]:
        try:
            p = [num(r["LONGITUD"]), num(r["LATITUD"])]
        except (KeyError, TypeError, ValueError):
            continue
        ents.append({"id": f"urn:ngsi-ld:AirQualityObserved:{r['CODIGO']}", "type": "AirQualityObserved",
                     "name": prop(r["ESTACION"]), "stationType": prop(r["NOM_TIPO"]),
                     "location": geo({"type": "Point", "coordinates": p})})
    return sorted(ents, key=lambda e: e["id"])


def write(name, obj):
    path = os.path.join(DATA, name)
    with open(path + ".part", "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    os.replace(path + ".part", path)
    return path


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def main():
    args = sys.argv[1:]
    offline = "--offline" in args
    if offline:
        global fetch
        _f = fetch
        fetch = lambda name, force=False, offline=True: _f(name, False, True)

    if "--live" in args:
        snap = json.load(open(os.path.join(DATA, "snapshot.json"), encoding="utf-8"))
        tids = {e["id"] for e in snap["entities"] if e["type"] == "TrafficFlowObserved"}
        ents = aq_fragments(fetch("aq.json", force=True)) + weather(full=False) + traffic(None, full=False, ids=tids)
        path = write("live.json", {"generated": now(), "entities": ents})
        print(f"snapshot: {path}: {len(ents)} entities", file=sys.stderr)
        return

    persons, stops, routes, buses, polylines = bus_lines()
    lamps = streetlights(polylines)
    ents = persons + stops + routes + buses + lamps + weather() + traffic(polylines) + aq_fragments(fetch("aq.json"))
    path = write("snapshot.json", {"generated": now(), "entities": ents, "stationsFallback": stations_fallback()})
    write("bridges.json", bridges())
    counts = {}
    for e in ents:
        counts[e["type"]] = counts.get(e["type"], 0) + 1
    print(f"snapshot: {path}: {len(ents)} entities {counts}", file=sys.stderr)


if __name__ == "__main__":
    main()
