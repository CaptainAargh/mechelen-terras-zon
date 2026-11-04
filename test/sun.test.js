const { test } = require('node:test');
const assert = require('node:assert');
const { loadScripts } = require('./load');

const get = loadScripts(['vendor/suncalc.js', 'vendor/turf.min.js', 'js/sun.js']);
const getSunPosition = get('getSunPosition');
const isTerraceInSun = get('isTerraceInSun');
const bearingToLabel = get('bearingToLabel');
const turf = get('turf');

// Synthetisch terras in het centrum van Mechelen.
const BAR = { lat: 51.0257, lon: 4.4776 };

/** Vierkant gebouw van `size` meter, met het midden `dist` meter van het terras in richting `bearing`. */
function building(dist, bearing, height, size = 10) {
  const c = turf.destination(turf.point([BAR.lon, BAR.lat]), dist / 1000, bearing, { units: 'kilometers' });
  const half = size / 2 / 1000;
  const corner = (b) => turf.destination(c, half * Math.SQRT2, b, { units: 'kilometers' }).geometry.coordinates;
  const ring = [corner(45), corner(135), corner(225), corner(315)];
  ring.push(ring[0]);
  return { height, polygon: turf.polygon([ring]) };
}

const sun = (bearing, altitudeDeg) => ({
  bearing,
  altitude: (altitudeDeg * Math.PI) / 180,
  isUp: altitudeDeg > 1.5,
});

test('kompaslabels', () => {
  assert.strictEqual(bearingToLabel(0), 'N');
  assert.strictEqual(bearingToLabel(90), 'O');
  assert.strictEqual(bearingToLabel(180), 'Z');
  assert.strictEqual(bearingToLabel(270), 'W');
  assert.strictEqual(bearingToLabel(359), 'N');
  assert.strictEqual(bearingToLabel(-90), 'W');
  assert.strictEqual(bearingToLabel(225), 'ZW');
});

test('zonnestand: zomerse middag in het zuiden, hoog; middernacht onder de horizon', () => {
  const noon = getSunPosition(new Date(Date.UTC(2026, 5, 21, 11, 42)));
  assert.ok(noon.isUp);
  assert.ok(Math.abs(noon.bearing - 180) < 5, `bearing ${noon.bearing}`);
  assert.ok(noon.altitudeDeg > 60 && noon.altitudeDeg < 64, `hoogte ${noon.altitudeDeg}`);

  const night = getSunPosition(new Date(Date.UTC(2026, 5, 21, 23, 0)));
  assert.strictEqual(night.isUp, false);
});

test('zonnestand: in de winter komt de zon op in het zuidoosten', () => {
  const morning = getSunPosition(new Date(Date.UTC(2026, 11, 21, 8, 0)));
  assert.ok(morning.bearing > 110 && morning.bearing < 150, `bearing ${morning.bearing}`);
});

test('zon onder de horizon: nooit in de zon', () => {
  assert.strictEqual(isTerraceInSun(BAR, [], sun(180, -5)), false);
});

test('geen gebouwen: in de zon', () => {
  assert.strictEqual(isTerraceInSun(BAR, [], sun(180, 30)), true);
});

test('hoog gebouw tussen terras en zon geeft schaduw', () => {
  // 20 m hoog, 20 m naar het zuiden; zon in het zuiden op 30 graden: schaduw tot 34 m.
  assert.strictEqual(isTerraceInSun(BAR, [building(20, 180, 20)], sun(180, 30)), false);
});

test('laag gebouw of hoge zon: geen schaduw', () => {
  assert.strictEqual(isTerraceInSun(BAR, [building(20, 180, 3)], sun(180, 30)), true);
  assert.strictEqual(isTerraceInSun(BAR, [building(20, 180, 20)], sun(180, 70)), true);
});

test('gebouw aan de andere kant dan de zon: geen schaduw', () => {
  assert.strictEqual(isTerraceInSun(BAR, [building(20, 0, 25)], sun(180, 30)), true);
});

test('gebouw te ver weg voor zijn hoogte: geen schaduw', () => {
  // 10 m hoog op 60 m bij 20 graden: schaduw reikt maar 27 m.
  assert.strictEqual(isTerraceInSun(BAR, [building(60, 180, 10)], sun(180, 20)), true);
});

test('terras tegen de gevel (snijpunt binnen 3 m) telt niet als schaduw', () => {
  // Gebouw van 10 m breed met het midden op 5 m: de gevel ligt op ongeveer 0 m.
  assert.strictEqual(isTerraceInSun(BAR, [building(5, 180, 20)], sun(180, 30)), true);
});
