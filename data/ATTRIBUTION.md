# Sources of the data

`snapshot.json` and `bridges.json` are built by `tools/snapshot.py` from these, retrieved 2026-10-18.

| data | source | licence |
|---|---|---|
| bus lines 27 and 2: routes, shapes, stops | EMT Madrid GTFS, `https://servicios.emtmadrid.es:8443/gtfs/transitemt.zip` (feed of 2026-10-13) | EMT Madrid open data terms - attribution: "Empresa Municipal de Transportes de Madrid (EMT)" |
| streetlights | Ayuntamiento de Madrid, datos.madrid.es `300573-0-unidades-luminosas-farolas` | CC BY 4.0 |
| air-quality stations | Ayuntamiento de Madrid, datos.madrid.es `212629-0-estaciones-control-aire` (DataStore `212629-0-estaciones-control-aire-csv`) | CC BY 4.0 |
| air-quality readings | Ayuntamiento de Madrid, datos.madrid.es `212531-0-calidad-aire-tiempo-real` (ciudadesabiertas.madrid.es `calair_tiemporeal`) | CC BY 4.0 |
| weather stations | Ayuntamiento de Madrid, datos.madrid.es `300360-0-meteorologicos-estaciones` | CC BY 4.0 |
| weather readings | Ayuntamiento de Madrid, datos.madrid.es `300392-0-meteorologia-tiempo-real` (ciudadesabiertas.madrid.es `meteo_tiemporeal`) | CC BY 4.0 |
| traffic | Ayuntamiento de Madrid, datos.madrid.es `202087-0-trafico-intensidad` (`https://informo.madrid.es/informo/tmadrid/pm.xml`) | CC BY 4.0 |

Not from any source - made up for the demo: the buses (fleet numbers 8701-8710, plates, models assigned
at random), their drivers (names and employee numbers), every bus's speed, occupancy and position.
