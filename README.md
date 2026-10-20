# c3-demo-madrid (CDMAD)

A smart-city demo for c³: Madrid's real bus lines 27 and 2, its streetlights, air-quality and weather
stations and traffic sensors, on a coraine broker - and a page that makes that world move.

- [Design](doc/design.md)

## Running it

Needs `coraine` in `PATH` (built with the WebSocket transport and the ckan bridge) and the cor-libs checked
out next to this repository (`COR_LIBS`, default `..`).

```bash
make          # the backend, ./cdmad
./cdmad       # http://localhost:7990 - the broker it starts listens on 9026
```

1. Open `http://localhost:7990` and press **Start broker + populate**: coraine starts (in-memory, TRoE on),
   Madrid is upserted (~900 entities), the ckan bridge reads the 24 air-quality stations from
   datos.madrid.es (without a network: the snapshot's copies).
2. In c³, type `CDMAD` in the broker field and press **Connect**.
3. Move the world in CDMAD - speeds, stop / break a bus, break a streetlight, NO₂, rain, jams, night - and
   watch c³ follow, with its alarms.

`make snapshot` rebuilds `data/snapshot.json` from the sources ([data](doc/data.md)).

Options: `./cdmad --port 7990 --broker-port 9026 --coraine <path> --www <dir>`.

## Data

Bus lines, shapes and stops: EMT Madrid open data (GTFS). Streetlights, air quality, weather and traffic:
Ayuntamiento de Madrid, datos.madrid.es / informo.madrid.es, CC BY 4.0. Bus drivers are fictional.
See [data/ATTRIBUTION.md](data/ATTRIBUTION.md).
