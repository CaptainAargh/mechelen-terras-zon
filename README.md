# Mechelen Terras in de Zon

Statische webapp die op een 3D-kaart van Mechelen toont welke terrassen nu in de zon liggen. Per terras wordt de
zonpositie (SunCalc) vergeleken met de schaduw van de omliggende gebouwen (OpenStreetMap), met filters op
openingsuren en betrouwbaarheid, een zonnekompas, een schaduwlaag en het weer.

## Lokaal starten
Er is geen build-stap en geen package manager: het is gewone HTML, CSS en JavaScript. Omdat de app `data/*.json`
met `fetch` laadt, moet je hem via een lokale webserver openen (een `file://`-pad werkt niet):

```bash
python -m http.server 8000
# open http://localhost:8000
```

Elke andere statische server werkt ook (bv. `npx serve .`).

## Hoe het werkt
- `index.html` laadt de bibliotheken uit `vendor/` (MapLibre GL, SunCalc, Turf) en dan `js/`.
- Terrassen komen eerst uit de statische bestanden `data/osm_bars.json` (OSM-momentopname) en `data/bars.json`
  (handmatig aangevulde zaken). Daarna ververst de app ze op de achtergrond via de Overpass API en cachet ze 30
  minuten in `sessionStorage`.
- Gebouwen komen live van Overpass, het kaartbeeld van OpenFreeMap en het weer van Open-Meteo. Geen API-sleutels
  of configuratie nodig.

| Bestand | Rol |
|---|---|
| `js/app.js` | opstart, laden en cachen, UI-updates, weer |
| `js/map.js` | MapLibre-kaart, 3D-gebouwen, schaduwlaag, markers |
| `js/osm.js` | Overpass-queries met fallback over meerdere mirrors |
| `js/sun.js` | zonpositie en de test "ligt dit terras in de zon" |
| `js/hours.js` | OSM `opening_hours` lezen ("nu open") |

## Controle
Er zijn geen tests. CI controleert de syntax van alle bestanden in `js/` (`node --check`) en of de JSON in
`data/` geldig is.

Zie `docs/STAND.md` voor de stand van het project.
