# c3-demo-madrid (CDMAD) - design

A smart-city demo for c³: Madrid, on a coraine broker, with a world that moves. CDMAD is the remote
control of that world - it starts the broker, fills it with real Madrid data, and changes things (bus
speeds, a broken streetlight, NO₂ over the limit); c³ is where it is watched, on its map, with alerts.

```
   CDMAD page (browser)  ── WebSocket, GET /ngsi-ld/v1/ws ──►  coraine :9026  ◄── WebSocket ──  c³ backend ◄── c³ page
        │  start / stop, snapshot, /c3.json                       ▲    ▲
        ▼                                                         │    └─ ckan bridge: datos.madrid.es (air-quality stations)
   CDMAD backend :7990 ── fork/exec ──────────────────────────────┘
```

## The flow of a demo

1. `cdmad` (the backend) runs; the page is `http://localhost:7990/`.
2. **Start broker + populate**: the backend starts coraine (ramDB, so every start is a clean city); the
   page opens a WebSocket to it and upserts the snapshot (`data/snapshot.json`) in batches.
3. In c³'s broker field: **`CDMAD`**, Connect. c³ fetches `http://127.0.0.1:7990/c3.json` (the
   descriptor, below), connects to the broker it names, shows the map where it says, watches the types it
   lists, and creates the alert subscriptions it lists - **c³ creates every subscription itself**, over
   the broker's WebSocket.
4. The page moves the buses (one batch update a second). Every change reaches c³ as a notification.
5. In CDMAD: a bus's speed, stop it, break it; click a streetlight to break it; push a station's NO₂
   over the limit; rain; a traffic jam; night (the streetlights go on). Each one is an update of an
   entity - and, where an alert rule matches, an alarm in c³.

## Ports

| | |
|---|---|
| 7990 | the CDMAD backend: the page, `/c3.json`, `/api/*` |
| 9026 | the broker it starts (HTTP and its WebSocket transport) |

## The broker

```
coraine -fg -p 9026 -db ramDB --troe ramDB --transports ws --bridges ckan --bridgeConfig data/bridges.json
```

`--troe ramDB`: the history c³'s history chart reads (the temporal API), in memory. The binary is
`coraine` from `PATH`, or `--coraine <path>`.

## The descriptor - `GET /c3.json`

What c³ needs to show a demo, and nothing of Madrid in c³ itself:

```json
{
  "name": "Madrid",
  "broker": "http://127.0.0.1:9026",
  "tenant": null,
  "view": { "mode": "map", "center": [-3.6930, 40.4300], "zoom": 12.6, "relationships": "selected" },
  "watch": ["PublicTransportRoute", "BusStop", "Bus", "Person", "Streetlight",
            "AirQualityObserved", "WeatherObserved", "TrafficFlowObserved"],
  "alerts": [
    { "id": "streetlight-out", "title": "Streetlight out",      "severity": "critical", "type": "Streetlight",         "q": "status==\"broken\"" },
    { "id": "bus-breakdown",   "title": "Bus breakdown",        "severity": "critical", "type": "Bus",                 "q": "status==\"broken\"" },
    { "id": "no2-limit",       "title": "NO₂ above the EU hourly limit (200 µg/m³)", "severity": "warning", "type": "AirQualityObserved", "q": "NO2>200" },
    { "id": "traffic-jam",     "title": "Traffic jam",          "severity": "warning",  "type": "TrafficFlowObserved", "q": "congested==true" }
  ]
}
```

`tenant` null: the default tenant. `view.relationships`: `"selected"` draws only the selected entity's
Relationships on the map (a route has dozens of stops).

## Entities

NGSI-LD, normalized, the core `@context` only - no user context: the demo must work with no network, and
short names expand to the default vocabulary. Types and attribute names follow the Smart Data Models where
there is one (`Streetlight`, `AirQualityObserved`, `WeatherObserved`, `TrafficFlowObserved`,
`PublicTransportRoute`), but the models' `@context` is not used.

| type | id | attributes |
|---|---|---|
| `PublicTransportRoute` | `urn:ngsi-ld:PublicTransportRoute:EMT-027-A` (line, direction A/B) | `name` ("27 Embajadores → Plaza de Castilla"), `routeShortName` ("27"), `routeColor` ("#0178BC"), `location` LineString (the GTFS shape, simplified to ≤ 300 points), `hasStop` ListRelationship (`objectList`, the stops' URIs in order), `stopDistances` (m along `location`, in `hasStop` order), `length` (m) |
| `BusStop` | `urn:ngsi-ld:BusStop:EMT-<stop_id>` | `name`, `stopCode`, `location` Point |
| `Bus` | `urn:ngsi-ld:Bus:EMT-<fleet number>` | `location` Point, `speed` (km/h, `unitCode` KMH), `bearing` (°), `status` (`inService`, `atStop`, `stopped`, `broken`), `occupancy` (0-100 %), `licensePlate`, `vehicleModel`, `onRoute` Relationship → route, `nextStop` Relationship → BusStop, `drivenBy` Relationship → Person |
| `Person` | `urn:ngsi-ld:Person:driver-<n>` | `name`, `employeeNumber` - **fictional** drivers |
| `Streetlight` | `urn:ngsi-ld:Streetlight:MAD-<x>-<y>` (the city's UTM coordinates, in metres) | `location` Point, `status` (`ok`, `broken`), `powerState` (`on`, `off`), `lampType`, `address` |
| `AirQualityObserved` | `urn:ngsi-ld:AirQualityObserved:<CODIGO>` | from the ckan bridge: `name`, `stationType`, `location`; from the snapshot / simulator: `NO2`, `PM10`, `O3` (µg/m³, `unitCode` GQ), `airQualityLevel` (`good`, `moderate`, `poor`, `veryPoor`), each with `observedAt` |
| `WeatherObserved` | `urn:ngsi-ld:WeatherObserved:<station code>` | `name`, `location`, `temperature` (°C), `relativeHumidity` (%), `precipitation` (mm/h, `unitCode` H67), `windSpeed` (m/s) |
| `TrafficFlowObserved` | `urn:ngsi-ld:TrafficFlowObserved:<idelem>` | `name` (the measuring point's description), `location`, `intensity` (vehicles/h), `occupancy` (%), `load` (0-100), `congested` (boolean) |

Two lines: **27** (Glorieta de Embajadores - Plaza de Castilla, the Castellana, north-south) and **2**
(Plaza de Manuel Becerra - Avenida Reina Victoria, east-west); they cross. Each direction its route,
4 to 6 buses a line.

## The data - `tools/snapshot.py`

Builds `data/snapshot.json` (the entities, in upsert order: drivers, stops, routes, buses, the rest) and
`data/bridges.json` (the ckan bridge's configuration) from:

| | source | licence |
|---|---|---|
| lines, shapes, stops | EMT Madrid GTFS, `https://servicios.emtmadrid.es:8443/gtfs/transitemt.zip` | EMT open data terms (attribution) |
| streetlights | datos.madrid.es `300573-0-unidades-luminosas-farolas` - the ones within 25 m of the two lines' shapes, at most one per 40 m of route | CC BY 4.0, Ayuntamiento de Madrid |
| air-quality stations | datos.madrid.es `212629-0-estaciones-control-aire` (DataStore resource `212629-0-estaciones-control-aire-csv`) - **through the ckan bridge**, not the snapshot | CC BY 4.0 |
| air-quality readings | datos.madrid.es `212531-0-calidad-aire-tiempo-real` | CC BY 4.0 |
| weather stations, readings | datos.madrid.es `300360-0-meteorologicos-estaciones`, the real-time weather data | CC BY 4.0 |
| traffic | `https://informo.madrid.es/informo/tmadrid/pm.xml` - the measuring points within 300 m of the lines, at most 300 | Ayuntamiento de Madrid |

`--live` writes only today's values (air quality, weather, traffic) as `data/live.json`: the backend runs
it for **Refresh from Madrid**. Without a network the snapshot in the repository is the city.

## CDMAD backend - `src/`

C, on the cor-libs (sibling checkouts, `COR_LIBS`), as c³'s backend is.

| | |
|---|---|
| `GET /`, `/js/*`, `/css/*`, `/data/*` | the page and the snapshot |
| `GET /c3.json` | the descriptor |
| `GET /api/broker` | `{ "running", "pid", "url", "uptime", "log" }` - the broker's log is `~/.local/share/cdmad/broker.log` |
| `POST /api/broker/start` | starts coraine (stops a running one first); answers once `/version` answers |
| `POST /api/broker/stop` | stops it (SIGTERM, then SIGKILL after 5 s) |
| `POST /api/refresh` | runs `tools/snapshot.py --live`, answers `data/live.json` |

The broker is the backend's child: it stops when the backend stops.

## CDMAD page - `www/`

- a map (MapLibre, online tiles; without network the lines, stops and streetlights are drawn on a plain
  background) with the routes, stops, buses, streetlights, stations
- **Start broker + populate** (progress), **Stop**
- per bus: speed slider (0-80 km/h), stop / go, break / repair
- time: simulation speed ×1 - ×10; day / night (night: every working streetlight `on`)
- click a streetlight: break / repair it
- per air-quality station: NO₂ slider; **rain** (precipitation, buses 20 % slower); **traffic jam** on a
  sensor (congested, the buses near it slowed to a crawl)
- one WebSocket to the broker; populate = `POST /ngsi-ld/v1/entityOperations/upsert?options=update` in
  batches of 100 (`update`: the ckan bridge may have made an air-quality station already, a replacing upsert
  would drop its `location`); the stations the bridge has not made in 20 s are upserted from the snapshot's
  `stationsFallback`
- the simulation = one `POST /ngsi-ld/v1/entityOperations/update` a second with every attribute that
  changed; a control (a bus stopped, a lamp broken) is sent at once
- a page loaded while the broker runs attaches: the world is read back from the broker
- **Refresh from Madrid**: `data/live.json` upserted with `options=update`

## c³ - what it gains (generic, not Madrid's)

| | |
|---|---|
| **a named demo** | a broker field value that is not a URL or host:port is a name: c³ looks it up in its configuration (`demos`, CDMAD built in as `http://127.0.0.1:7990/c3.json`) and connects as the descriptor says |
| **alerts** | rules (type + `q`, title, severity) per broker - from a descriptor, or added in c³; each one a subscription c³ creates over the broker's WebSocket. A notification raises an alarm (toast, alarm list, the entity pulsing on the map); the entity no longer matching clears it |
| **smooth motion** | a Point that changes glides to its new position instead of jumping |
| **icons** | a marker per type (bus, stop, streetlight, station), status coloured |
| **history** | an entity's numeric attributes over the last minutes, from the temporal API |
