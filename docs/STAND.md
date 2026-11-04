# Stand mechelen-terras-zon (2026-11-04)

## Wat het doet
Statische webapp (HTML/CSS/JS, geen build) die op een 3D-kaart van Mechelen toont welke terrassen nu in de zon
liggen: zonpositie via SunCalc, schaduw van OSM-gebouwen, filters op openingsuren en betrouwbaarheid,
zonnekompas, schaduwlaag en weer (Open-Meteo). Zie `README.md`.

## Bouwt het / tests
- Geen build-stap en geen `package.json`. Lokaal gestart met `python -m http.server`: `index.html`, `js/`,
  `data/` en `vendor/` worden geserveerd (HTTP 200). Niet in een browser bekeken in deze ronde.
- Geen tests. CI (nieuw) doet als rooktest `node --check` op `js/*.js` en valideert de JSON in `data/`: beide
  groen lokaal.
- Er was geen README; die is toegevoegd.

## Starten: configuratie
Geen configuratie, sleutels of omgevingsvariabelen nodig. Externe diensten tijdens gebruik: OpenFreeMap
(kaartstijl), Overpass-mirrors (terrassen en gebouwen), Open-Meteo (weer).

## Wat open is
- `vendor/leaflet.js` en `vendor/leaflet.css` worden nergens meer geladen sinds de overstap naar MapLibre
  (`1260f40`): dode code, niet verwijderd.
- De bibliotheken staan als kopie in `vendor/` (MapLibre GL 5.22.0, Leaflet 1.9.4, SunCalc, Turf). Dependabot kan
  die niet volgen; de nieuwe `dependabot.yml` dekt alleen de GitHub Actions.
- Dependabot-alerts staan uit voor deze repo (repo-instelling).
- Geen hosting gevonden in de repo (geen Pages- of deploy-config); of de app ergens online staat is niet nagekeken.

## Nog actief?
Laatste commit 2026-04-10 (kleur van 3D-gebouwen). Sindsdien stil: lijkt af of geparkeerd.
