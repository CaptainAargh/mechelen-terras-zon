const { test } = require('node:test');
const assert = require('node:assert');
const { loadScripts } = require('./load');

const plain = (x) => JSON.parse(JSON.stringify(x));

function load() {
  return loadScripts(['vendor/turf.min.js', 'js/hours.js', 'js/map.js']);
}

/** Nep-MapLibre-kaart: onthoudt setData en setLayoutProperty. */
function fakeMap({ sources = ['bars', 'shadows'], layers = [] } = {}) {
  const data = {};
  const layout = [];
  return {
    data, layout,
    getSource: (id) => (sources.includes(id) ? { setData: (d) => { data[id] = d; } } : undefined),
    getLayer: (id) => layers.find((l) => l.id === id),
    getStyle: () => ({ layers }),
    setLayoutProperty: (id, prop, val) => layout.push([id, prop, val]),
  };
}

const bar = (id, terrace, inSun, isOpen, extra = {}) => ({ id, name: id, lat: 51.02, lon: 4.47, terrace, inSun, isOpen, ...extra });

const BARS = [
  bar('zeker-zon-open', 'yes', true, true),
  bar('waarsch-schaduw', 'likely', false, null),
  bar('misschien-zon-dicht', 'maybe', true, false),
  bar('geen-terras', 'no', true, true),
  bar('onbekend-rang', undefined, null, null),
];

test('updateBarMarkers: rang 0 nooit, minimale zekerheid, enkel zon en enkel open', () => {
  const get = load();
  const upd = get('updateBarMarkers');
  assert.deepStrictEqual(plain(upd(BARS, { onlySunny: false, onlyOpen: false, minConfidence: 0 })), { sunnyCount: 2, shownCount: 4 });
  assert.deepStrictEqual(plain(upd(BARS, { onlySunny: false, onlyOpen: false, minConfidence: 2 })), { sunnyCount: 1, shownCount: 2 });
  assert.deepStrictEqual(plain(upd(BARS, { onlySunny: true, onlyOpen: false, minConfidence: 1 })), { sunnyCount: 2, shownCount: 2 });
  // isOpen === null (onbekend) blijft zichtbaar bij "enkel open", alleen false valt weg
  assert.deepStrictEqual(plain(upd(BARS, { onlySunny: false, onlyOpen: true, minConfidence: 1 })), { sunnyCount: 1, shownCount: 3 });
});

test('updateBarMarkers: zet in de wachtrij zolang de kaart niet klaar is, daarna naar de bron', () => {
  const get = load();
  get('updateBarMarkers')(BARS.slice(0, 1), { onlySunny: false, onlyOpen: false, minConfidence: 0 });
  assert.deepStrictEqual(plain(get('pendingBars')).features.map((f) => f.properties.id), ['zeker-zon-open']);

  const m = fakeMap();
  get.context.__m = m;
  get('map = __m; isMapReady = true');
  get('updateBarMarkers')(BARS, { onlySunny: true, onlyOpen: false, minConfidence: 0 });
  assert.strictEqual(m.data.bars.type, 'FeatureCollection');
  assert.deepStrictEqual(plain(m.data.bars.features.map((f) => f.properties.id)), ['zeker-zon-open', 'misschien-zon-dicht']);
});

test('_barToFeature: standaardwaarden en de vlaggen inSun, inSunUnknown, isNight', () => {
  const toF = load()('_barToFeature');
  const f = plain(toF({ id: 'a', name: 'A', lat: 51, lon: 4, inSun: null }));
  assert.deepStrictEqual(f, {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [4, 51] },
    properties: {
      id: 'a', name: 'A', amenity: 'bar', address: '', opening_hours: '', phone: '', website: '',
      terrace: 'maybe', inSun: false, inSunUnknown: true, isNight: false, isOpen: null,
    },
  });
  const g = plain(toF({ id: 'b', name: 'B', lat: 51, lon: 4, inSun: true, _isNight: true, isOpen: false, amenity: 'pub', terrace: 'yes' }));
  assert.strictEqual(g.properties.inSun, true);
  assert.strictEqual(g.properties.inSunUnknown, false);
  assert.strictEqual(g.properties.isNight, true);
  assert.strictEqual(g.properties.isOpen, false);
  assert.strictEqual(g.properties.amenity, 'pub');
});

test('_esc: escapet HTML-tekens, leeg voor null', () => {
  const esc = load()('_esc');
  assert.strictEqual(esc('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  assert.strictEqual(esc(null), '');
  assert.strictEqual(esc(undefined), '');
  assert.strictEqual(esc(0), '');
  assert.strictEqual(esc(12), '12');
});

test('_buildPopupHtml: zonbadge per toestand', () => {
  const html = load()('_buildPopupHtml');
  const base = { name: 'X', terrace: 'yes', amenity: 'bar' };
  assert.match(html({ ...base, isNight: true, inSunUnknown: true }), /Nacht/);
  assert.match(html({ ...base, inSunUnknown: true }), /Schaduw laden/);
  assert.match(html({ ...base, inSun: true }), /Terras in de zon/);
  assert.match(html({ ...base, inSun: false }), /Terras in de schaduw/);
});

test('_buildPopupHtml: escapet naam, adres en telefoon; enkel http-links als website', () => {
  const html = load()('_buildPopupHtml');
  const out = html({
    name: '<script>alert(1)</script>', address: 'Straat "1"', phone: '<b>0</b>', terrace: 'likely', amenity: 'cafe',
    website: 'javascript:alert(1)', inSun: false,
  });
  assert.ok(!out.includes('<script>'));
  assert.match(out, /&lt;script&gt;/);
  assert.match(out, /Straat &quot;1&quot;/);
  assert.match(out, /&lt;b&gt;0&lt;\/b&gt;/);
  assert.match(out, /Café/);
  assert.match(out, /Waarschijnlijk terras/);
  assert.ok(!out.includes('javascript:'), 'geen javascript:-link');
  assert.match(out, /Openingsuren onbekend/);

  const ok = html({ name: 'Y', terrace: 'onbekend', amenity: 'iets', website: 'https://voorbeeld.test/?a=1&b=2', inSun: true });
  assert.match(ok, /href="https:\/\/voorbeeld.test\/\?a=1&amp;b=2"/);
  assert.match(ok, /rel="noopener noreferrer"/);
  assert.match(ok, /<p class="address">Bar<\/p>/, 'onbekende amenity wordt Bar, zonder adres geen scheidingsteken');
});

test('_buildPopupHtml: openingsuren via isOpenNow en openLabel', () => {
  const html = load()('_buildPopupHtml');
  assert.match(html({ name: 'Z', terrace: 'no', amenity: 'pub', opening_hours: '24/7' }), /Nu open · 24\/7/);
  assert.match(html({ name: 'Z', terrace: 'no', amenity: 'pub', opening_hours: '24/7' }), /Geen terras/);
});

// Gebouw van 10 x 10 m in het centrum van Mechelen.
function building(height) {
  const get = load();
  const turf = get('turf');
  const ring = [[4.4776, 51.0257], [4.4777, 51.0257], [4.4777, 51.0258], [4.4776, 51.0258], [4.4776, 51.0257]];
  return { get, turf, b: { height, polygon: turf.polygon([ring]) } };
}

test('_computeShadowPolygon: lengte h/tan(hoogte), tegengesteld aan de zon, maximaal 300 m', () => {
  const { get, turf, b } = building(20);
  const shadow = get('_computeShadowPolygon');
  const deg = (d) => (d * Math.PI) / 180;

  // Zon in het zuiden op 45 graden: schaduw 20 m naar het noorden.
  const s45 = shadow(b, { bearing: 180, altitude: deg(45) });
  const lats45 = s45.geometry.coordinates[0].map((c) => c[1]);
  const north45 = turf.distance([4.4776, 51.0258], [4.4776, Math.max(...lats45)], { units: 'meters' });
  assert.ok(Math.abs(north45 - 20) < 0.5, `schaduw ${north45} m`);
  assert.ok(Math.min(...lats45) >= 51.0257 - 1e-9, 'niets naar het zuiden');

  // Heel lage zon: begrensd op 300 m.
  const sLow = shadow(b, { bearing: 180, altitude: deg(0.5) });
  const latsLow = sLow.geometry.coordinates[0].map((c) => c[1]);
  const northLow = turf.distance([4.4776, 51.0258], [4.4776, Math.max(...latsLow)], { units: 'meters' });
  assert.ok(Math.abs(northLow - 300) < 1, `schaduw ${northLow} m`);
});

test('_computeShadowPolygon: null als de schaduw korter is dan 1 m', () => {
  const { get, b } = building(0.5);
  assert.strictEqual(get('_computeShadowPolygon')(b, { bearing: 90, altitude: Math.PI / 4 }), null);
});

test('updateShadowOverlay: niets zonder kaart, leeg bij uit/nacht/lage zon, anders schaduwen', () => {
  const { get, b } = building(20);
  const up = get('updateShadowOverlay');
  const sun = { bearing: 180, altitude: Math.PI / 4, altitudeDeg: 45, isUp: true };
  up([b], sun, true); // kaart niet klaar: mag niet gooien

  const m = fakeMap();
  get.context.__m = m;
  get('map = __m; isMapReady = true');
  for (const [buildings, s, show] of [
    [[b], sun, false],
    [[], sun, true],
    [null, sun, true],
    [[b], { ...sun, isUp: false }, true],
    [[b], { ...sun, altitudeDeg: 1.5 }, true],
  ]) {
    m.data.shadows = undefined;
    up(buildings, s, show);
    assert.deepStrictEqual(plain(m.data.shadows), { type: 'FeatureCollection', features: [] });
  }
  up([b, { ...b, height: 0.1 }], sun, true);
  assert.strictEqual(m.data.shadows.features.length, 1, 'te korte schaduw valt weg');

  const noSource = fakeMap({ sources: ['bars'] });
  get.context.__m = noSource;
  get('map = __m');
  up([b], sun, true); // geen bron 'shadows': geen fout
});

test('toggleBuildings: eigen laag en alle gebouwlagen van de basisstijl', () => {
  const get = load();
  get('toggleBuildings')(true); // geen kaart: geen fout
  const m = fakeMap({ layers: [
    { id: 'building-3d-custom' },
    { id: 'building', 'source-layer': 'building' },
    { id: 'building-3d', 'source-layer': 'building' },
    { id: 'water', 'source-layer': 'water' },
  ] });
  get.context.__m = m;
  get('map = __m; isMapReady = true');
  get('toggleBuildings')(false);
  assert.deepStrictEqual(plain(m.layout), [
    ['building-3d-custom', 'visibility', 'none'],
    ['building', 'visibility', 'none'],
    ['building-3d', 'visibility', 'none'],
  ]);
  m.layout.length = 0;
  get('toggleBuildings')(true);
  assert.ok(m.layout.every(([, , v]) => v === 'visible'));
});
