const { test } = require('node:test');
const assert = require('node:assert');
const { loadScripts } = require('./load');

// Objecten uit de vm-context hebben een ander Object.prototype: vergelijk via JSON.
const plain = (x) => JSON.parse(JSON.stringify(x));
const quiet = { log() {}, warn() {}, error() {} };
// overpassFetch ruimt zijn time-out niet op bij een HTTP-fout; unref zodat de test niet 30 s blijft hangen.
const unrefTimeout = (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; };

/** Nep-fetch: geeft per oproep het volgende antwoord uit de lijst, en onthoudt de oproepen. */
function fakeFetch(answers) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a instanceof Error) throw a;
    return { ok: a.ok !== false, status: a.status || 200, json: async () => a.body };
  };
  fn.calls = calls;
  return fn;
}

function load(globals = {}) {
  return loadScripts(['vendor/turf.min.js', 'js/osm.js'], { console: quiet, ...globals });
}

test('terraceConfidence: expliciete tags gaan voor de heuristiek', () => {
  const tc = load()('terraceConfidence');
  assert.strictEqual(tc(undefined), 'maybe');
  assert.strictEqual(tc({ outdoor_seating: 'yes', amenity: 'restaurant' }), 'yes');
  assert.strictEqual(tc({ outdoor_seating: 'no', amenity: 'bar' }), 'no');
  assert.strictEqual(tc({ terrace: 'yes' }), 'yes');
  assert.strictEqual(tc({ terrace: 'no', amenity: 'pub' }), 'no');
  assert.strictEqual(tc({ amenity: 'bar' }), 'likely');
  assert.strictEqual(tc({ amenity: 'pub' }), 'likely');
  assert.strictEqual(tc({ amenity: 'cafe' }), 'maybe');
  assert.strictEqual(tc({ amenity: 'restaurant' }), 'maybe');
  assert.strictEqual(tc({ amenity: 'nightclub' }), 'maybe');
  assert.strictEqual(tc({}), 'maybe');
});

test('buildAddress: straat, nummer en stad; null zonder adres', () => {
  const ba = load()('buildAddress');
  assert.strictEqual(ba({ 'addr:street': 'Teststraat', 'addr:housenumber': '7', 'addr:city': 'Mechelen' }), 'Teststraat 7 Mechelen');
  assert.strictEqual(ba({ 'addr:street': 'Teststraat' }), 'Teststraat');
  assert.strictEqual(ba({ 'addr:city': 'Mechelen' }), 'Mechelen');
  assert.strictEqual(ba({}), null);
});

test('parseOsmBars: node en way (zwaartepunt), andere amenities en lege geometrie vallen weg', () => {
  const parse = load()('parseOsmBars');
  const bars = plain(parse([
    { type: 'node', id: 1, lat: 51.02, lon: 4.47, tags: {
      amenity: 'bar', name: 'Testbar', 'addr:street': 'Teststraat', 'addr:housenumber': '1',
      'contact:phone': '+32 0 000 00 00', 'contact:website': 'https://voorbeeld.test', opening_hours: 'Mo-Su 10:00-22:00',
      outdoor_seating: 'yes' } },
    { type: 'way', id: 2, tags: { amenity: 'cafe' }, geometry: [{ lat: 51.0, lon: 4.4 }, { lat: 51.2, lon: 4.6 }] },
    { type: 'node', id: 3, lat: 51.0, lon: 4.4, tags: { amenity: 'public_bookcase' } },
    { type: 'node', id: 4, lat: 51.0, lon: 4.4 },
    { type: 'way', id: 5, tags: { amenity: 'pub' }, geometry: [] },
    { type: 'relation', id: 6, tags: { amenity: 'bar' } },
  ]));
  assert.strictEqual(bars.length, 2);
  assert.deepStrictEqual(bars[0], {
    id: 'osm_node_1', name: 'Testbar', lat: 51.02, lon: 4.47, amenity: 'bar',
    address: 'Teststraat 1', phone: '+32 0 000 00 00', website: 'https://voorbeeld.test',
    opening_hours: 'Mo-Su 10:00-22:00', terrace: 'yes', source: 'osm', inSun: null, isOpen: null,
  });
  assert.strictEqual(bars[1].id, 'osm_way_2');
  assert.strictEqual(bars[1].name, 'Naamloze kroeg');
  assert.ok(Math.abs(bars[1].lat - 51.1) < 1e-9);
  assert.ok(Math.abs(bars[1].lon - 4.5) < 1e-9);
  assert.strictEqual(bars[1].address, null);
  assert.strictEqual(bars[1].phone, null);
  assert.strictEqual(bars[1].website, null);
  assert.strictEqual(bars[1].terrace, 'maybe');
});

test('parseOsmBars: phone en website zonder contact:-prefix', () => {
  const parse = load()('parseOsmBars');
  const [bar] = plain(parse([{ type: 'node', id: 9, lat: 51, lon: 4, tags: { amenity: 'restaurant', phone: '000', website: 'https://x.test' } }]));
  assert.strictEqual(bar.phone, '000');
  assert.strictEqual(bar.website, 'https://x.test');
});

const square = (n = 4) => {
  const pts = [{ lat: 51.025, lon: 4.475 }, { lat: 51.025, lon: 4.476 }, { lat: 51.026, lon: 4.476 }, { lat: 51.026, lon: 4.475 }];
  return pts.slice(0, n);
};

test('parseOsmBuildings: sluit de ring, hoogte uit height, verdiepingen of standaard', () => {
  const parse = load()('parseOsmBuildings');
  const out = parse([
    { type: 'way', id: 1, geometry: square(), tags: { height: '12.5' } },
    { type: 'way', id: 2, geometry: [...square(), square()[0]], tags: { 'building:levels': '3' } },
    { type: 'way', id: 3, geometry: square(), tags: {} },
    { type: 'way', id: 4, geometry: square(), tags: { height: 'hoog' } },
    { type: 'way', id: 5, geometry: square(), tags: { 'building:levels': 'veel' } },
    { type: 'way', id: 6, geometry: square() },
  ]);
  assert.deepStrictEqual(plain(out.map((b) => [b.id, b.height])), [
    ['osm_way_1', 12.5], ['osm_way_2', 3 * 3.2], ['osm_way_3', 8], ['osm_way_4', 8], ['osm_way_5', 2 * 3.2], ['osm_way_6', 8],
  ]);
  const ring = out[0].polygon.geometry.coordinates[0];
  assert.strictEqual(ring.length, 5, 'open ring wordt gesloten');
  assert.deepStrictEqual(plain(ring[0]), plain(ring[4]));
  assert.strictEqual(out[1].polygon.geometry.coordinates[0].length, 5, 'gesloten ring krijgt geen extra punt');
});

test('parseOsmBuildings: nodes, te weinig punten en ongeldige polygonen vallen weg', () => {
  const parse = load()('parseOsmBuildings');
  const out = parse([
    { type: 'node', id: 1, lat: 51, lon: 4 },
    { type: 'way', id: 2, geometry: square(3) },
    { type: 'way', id: 3 },
    // NaN als beginpunt: de ring sluit nooit (NaN !== NaN), turf.polygon gooit, het gebouw valt weg
    { type: 'way', id: 4, geometry: [{ lat: NaN, lon: NaN }, ...square(3)] },
  ]);
  assert.strictEqual(out.length, 0);
});

test('overpassFetch: valt door naar de volgende mirror bij HTTP-fout, exception of fout antwoord', async () => {
  const fetch = fakeFetch([
    { ok: false, status: 503 },
    new Error('netwerk weg'),
    { body: { geen: 'elements' } },
    { body: { elements: [{ id: 1 }] } },
  ]);
  const get = load({ fetch, setTimeout: unrefTimeout, clearTimeout, AbortController });
  const data = await get('overpassFetch')('[out:json];', 1000);
  assert.deepStrictEqual(plain(data), { elements: [{ id: 1 }] });
  assert.strictEqual(fetch.calls.length, 4);
  assert.strictEqual(fetch.calls[0].opts.method, 'POST');
  assert.strictEqual(fetch.calls[0].opts.body, '[out:json];');
  const mirrors = get('OVERPASS_MIRRORS');
  assert.deepStrictEqual(fetch.calls.map((c) => c.url), [...mirrors]);
});

test('overpassFetch: null als geen enkele mirror werkt', async () => {
  const fetch = fakeFetch([new Error('weg')]);
  const get = load({ fetch, setTimeout: unrefTimeout, clearTimeout, AbortController });
  assert.strictEqual(await get('overpassFetch')('q', 1000), null);
  assert.strictEqual(fetch.calls.length, get('OVERPASS_MIRRORS').length);
});

test('fetchBarsWithTerraces en fetchBuildings: parsen het antwoord, null bij totale storing', async () => {
  const ok = fakeFetch([{ body: { elements: [
    { type: 'node', id: 1, lat: 51, lon: 4, tags: { amenity: 'pub' } },
    { type: 'way', id: 2, geometry: square(), tags: { building: 'yes' } },
  ] } }]);
  let get = load({ fetch: ok, setTimeout: unrefTimeout, clearTimeout, AbortController });
  const bars = await get('fetchBarsWithTerraces')();
  assert.deepStrictEqual(plain(bars.map((b) => b.id)), ['osm_node_1']);
  assert.match(ok.calls[0].opts.body, /amenity/);
  const buildings = await get('fetchBuildings')();
  assert.deepStrictEqual(plain(buildings.map((b) => b.id)), ['osm_way_2']);
  assert.match(ok.calls[1].opts.body, /building/);

  const down = fakeFetch([new Error('weg')]);
  get = load({ fetch: down, setTimeout: unrefTimeout, clearTimeout, AbortController });
  assert.strictEqual(await get('fetchBarsWithTerraces')(), null);
  assert.strictEqual(await get('fetchBuildings')(), null);
});

test('fetchStaticBars: leest data/osm_bars.json, lege lijst bij fout', async () => {
  const ok = fakeFetch([{ body: { elements: [{ type: 'node', id: 1, lat: 51, lon: 4, tags: { amenity: 'bar' } }] } }]);
  let get = load({ fetch: ok });
  assert.strictEqual((await get('fetchStaticBars')()).length, 1);
  assert.strictEqual(ok.calls[0].url, 'data/osm_bars.json');

  get = load({ fetch: fakeFetch([{ body: {} }]) });
  assert.strictEqual((await get('fetchStaticBars')()).length, 0, 'zonder elements');
  get = load({ fetch: fakeFetch([{ ok: false, status: 404 }]) });
  assert.strictEqual((await get('fetchStaticBars')()).length, 0, 'HTTP-fout');
  get = load({ fetch: fakeFetch([new Error('weg')]) });
  assert.strictEqual((await get('fetchStaticBars')()).length, 0, 'netwerkfout');
});
