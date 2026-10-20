# The data

`tools/snapshot.py` (Python 3, standard library only) makes Madrid out of the city's open data.

```
python3 -I tools/snapshot.py              # data/snapshot.json, data/bridges.json
python3 -I tools/snapshot.py --live       # data/live.json - today's air quality, weather, traffic
python3 -I tools/snapshot.py --offline    # from data/cache/ only, nothing downloaded
```

Downloads are kept in `data/cache/` (not in git): a second run downloads nothing but `--live`'s three
feeds. Sources and licences: [data/ATTRIBUTION.md](../data/ATTRIBUTION.md).

## `data/snapshot.json`

```json
{ "generated": "2026-10-18T06:28:12Z", "entities": [ ... ], "stationsFallback": [ ... ] }
```

`entities` - NGSI-LD, normalized, no `@context`, in upsert order:

| type | count | |
|---|---:|---|
| `Person` | 10 | the drivers - fictional |
| `BusStop` | 112 | the stops of the four routes (a stop served in both directions is one entity) |
| `PublicTransportRoute` | 4 | 27 A/B, 2 A/B |
| `Bus` | 10 | 6 on line 27, 4 on line 2, half each direction |
| `Streetlight` | 417 | |
| `WeatherObserved` | 26 | 24 with readings |
| `TrafficFlowObserved` | 300 | |
| `AirQualityObserved` | 23 | readings only (`NO2`, `PM10`, `O3`, `airQualityLevel`) - the stations come from the ckan bridge |

`stationsFallback` - the 24 air-quality stations (`id`, `type`, `name`, `stationType`, `location`) as the
ckan bridge makes them from `bridges.json`: upserted only when the bridge has not made them (no network).
Not in `entities`.

About 440 KB.

## `data/bridges.json`

The broker's `--bridgeConfig`: the `ckan` bridge reads datos.madrid.es's DataStore resource
`212629-0-estaciones-control-aire-csv` once, at start - 24 rows, 24 `AirQualityObserved`:
`urn:ngsi-ld:AirQualityObserved:{CODIGO}`, `name` ← `ESTACION`, `stationType` ← `NOM_TIPO`, `location` ←
(`LONGITUD`, `LATITUD`).

## `data/live.json`

```json
{ "generated": "...", "entities": [ ... ] }
```

Fragments of the same entities - `id`, `type` and the readings only - for
`POST /ngsi-ld/v1/entityOperations/upsert?options=update`: `AirQualityObserved` (readings),
`WeatherObserved` (readings), `TrafficFlowObserved` (`intensity`, `occupancy`, `load`, `congested`) - only
the measuring points that are in the snapshot. Not in git.

## The rules

**Lines.** GTFS routes `027` and `002`; for each direction (`direction_id` 0 = shape `_A`, 1 = `_B`) the
trip of that shape with the most stops gives the stops, in `stop_sequence` order. The shape is simplified
(Douglas-Peucker) to at most 300 points. A route's name is `<line> <from> → <to>`, the ends from
`route_long_name`.

**`stopDistances`** (on each `PublicTransportRoute`, not in the design's table): each stop's distance in
metres along the route's simplified `location`, in `hasStop` order - increasing, the first about 0. What
the simulator moves a bus along.

**Buses.** Spaced evenly along their route (the i-th of n at (i + ½)/n of its length), on the line;
`nextStop` is the first stop past the bus; `bearing` the direction of the line there.

**Streetlights.** Of the city's 233 308 lamps, those within **25 m** of one of the four shapes, and at most
one per **40 m** of a line (both directions of a line share their streets): of the lamps in one 40 m stretch
of a line, the nearest to it. The city's file has no id per lamp: the id is its UTM coordinates, in
metres, `urn:ngsi-ld:Streetlight:MAD-<x>-<y>`. `lampType` is the city's `TIPOL` (`LED`, `DESCARGA`, ...).
All `status` `ok`, `powerState` `off`.

**Traffic.** `pm.xml`'s measuring points without error (`error` `N`) and with a load (`carga` ≥ 0), within
**300 m** of a shape, the **300** nearest. `congested` is `nivelServicio` ≥ 2 - the city's levels are 0
fluid, 1 slow, 2 queues, 3 congestion. `intensity` vehicles/h, `occupancy` %, `load` 0-100.

**Readings.** The latest hour of today marked valid (`V`) per station and magnitude, its time as
`observedAt` (Madrid time → UTC; `H24` is 23:59:59). Magnitudes: 8 `NO2`, 10 `PM10`, 14 `O3` (µg/m³,
`unitCode` GQ); 81 `windSpeed` (m/s, MTS), 83 `temperature` (°C, CEL), 86 `relativeHumidity` (%, P1), 89
`precipitation` (l/m² in the hour = mm/h, H67).

**`airQualityLevel`** - the EEA European Air Quality Index bands, the worst of the three pollutants,
six levels made four:

| µg/m³ | good | fair | moderate | poor | very poor | extremely poor |
|---|---|---|---|---|---|---|
| NO2 | ≤ 40 | ≤ 90 | ≤ 120 | ≤ 230 | ≤ 340 | above |
| PM10 | ≤ 20 | ≤ 40 | ≤ 50 | ≤ 100 | ≤ 150 | above |
| O3 | ≤ 50 | ≤ 100 | ≤ 130 | ≤ 240 | ≤ 380 | above |
| **level** | `good` | `good` | `moderate` | `poor` | `veryPoor` | `veryPoor` |

**Coordinates.** WGS84, 6 decimals (about 0.1 m); the city's files give UTM ETRS89 zone 30N (decimal comma),
converted by the tool.
