const { test } = require('node:test');
const assert = require('node:assert');
const { loadScripts } = require('./load');

const plain = (x) => JSON.parse(JSON.stringify(x));
const quiet = { log() {}, warn() {}, error() {} };
// overpassFetch ruimt zijn time-out niet op bij een HTTP-fout; unref zodat de test niet 30 s blijft hangen.
const unrefTimeout = (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; };

/** Minimale nep-DOM: getElementById maakt elementen op aanvraag, addEventListener onthoudt de handlers. */
function fakeDocument() {
  const els = {};
  const handlers = {};
  const el = (id) => {
    if (!els[id]) {
      els[id] = {
        id, textContent: '', innerHTML: '', className: '', checked: false, value: '0',
        attrs: { title: 'x' },
        style: { setProperty(k, v) { this[k] = v; } },
        removeAttribute(a) { delete this.attrs[a]; },
        addEventListener() {},
      };
    }
    return els[id];
  };
  return {
    els, handlers,
    getElementById: el,
    querySelectorAll: () => [],
    addEventListener: (ev, fn) => { handlers[ev] = fn; },
  };
}

function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
}

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    const a = key ? routes[key] : { ok: false, status: 404 };
    if (a instanceof Error) throw a;
    return { ok: a.ok !== false, status: a.status || 200, json: async () => a.body };
  };
  fn.calls = calls;
  return fn;
}

function load(globals = {}) {
  const document = globals.document || fakeDocument();
  const get = loadScripts(
    ['vendor/suncalc.js', 'vendor/turf.min.js', 'js/osm.js', 'js/hours.js', 'js/sun.js', 'js/map.js', 'js/app.js'],
    { console: quiet, sessionStorage: fakeStorage(), Date, ...globals, document },
  );
  return { get, document };
}

const BAR = { id: 'a', name: 'A', lat: 51.0257, lon: 4.4776, amenity: 'bar' };

test('app.js registreert alleen een DOMContentLoaded-handler bij het laden', () => {
  const { document } = load();
  assert.deepStrictEqual(Object.keys(document.handlers), ['DOMContentLoaded']);
});

test('mergeBars: handmatige bar binnen 40 m van een OSM-bar is een dubbel', () => {
  const { get } = load();
  const turf = get('turf');
  const at = (m) => turf.destination(turf.point([BAR.lon, BAR.lat]), m / 1000, 90).geometry.coordinates;
  const [lon30, lat30] = at(30);
  const [lon60, lat60] = at(60);
  const out = plain(get('mergeBars')([BAR], [
    { id: 'dubbel', lat: lat30, lon: lon30 },
    { id: 'apart', lat: lat60, lon: lon60 },
    { id: 'eigen-bron', lat: lat60, lon: lon60, source: 'ander' },
  ]));
  assert.deepStrictEqual(out.map((b) => [b.id, b.source]), [['a', undefined], ['apart', 'manual'], ['eigen-bron', 'ander']]);
  assert.strictEqual(get('mergeBars')([], []).length, 0);
});

test('mergeBars: een kapotte coordinaat telt niet als dubbel', () => {
  const { get } = load();
  const out = get('mergeBars')([{ id: 'stuk', lat: 'x', lon: null }], [{ id: 'm', lat: 51, lon: 4 }]);
  assert.deepStrictEqual(plain(out.map((b) => b.id)), ['stuk', 'm']);
});

test('cacheGet/cacheSet: bewaart, verloopt na 30 minuten, verdraagt kapotte of volle opslag', () => {
  let now = 1_000_000;
  const FakeDate = class extends Date {};
  FakeDate.now = () => now;
  const storage = fakeStorage();
  const { get } = load({ Date: FakeDate, sessionStorage: storage });
  get('cacheSet')('k', [1, 2]);
  assert.deepStrictEqual(plain(get('cacheGet')('k')), [1, 2]);
  now += 30 * 60 * 1000;
  assert.deepStrictEqual(plain(get('cacheGet')('k')), [1, 2], 'precies 30 min is nog geldig');
  now += 1;
  assert.strictEqual(get('cacheGet')('k'), null);
  assert.strictEqual(get('cacheGet')('bestaat-niet'), null);
  storage.setItem('kapot', '{geen json');
  assert.strictEqual(get('cacheGet')('kapot'), null);

  const full = { getItem() { throw new Error('geblokkeerd'); }, setItem() { throw new Error('vol'); } };
  const { get: get2 } = load({ sessionStorage: full });
  get2('cacheSet')('k', 1); // mag niet gooien
  assert.strictEqual(get2('cacheGet')('k'), null);
});

test('loadManualBars: vult terras aan via terraceConfidence, lege lijst bij fout', async () => {
  const fetch = fakeFetch({ 'data/bars.json': { body: [
    { id: 'm1', amenity: 'pub' },
    { id: 'm2', amenity: 'cafe', outdoor_seating: 'yes' },
    { id: 'm3', amenity: 'bar', terrace: 'no' },
  ] } });
  let { get } = load({ fetch });
  const out = plain(await get('loadManualBars')());
  assert.deepStrictEqual(out.map((b) => [b.id, b.terrace, b.inSun, b.isOpen]), [
    ['m1', 'likely', null, null], ['m2', 'yes', null, null], ['m3', 'no', null, null],
  ]);
  ({ get } = load({ fetch: fakeFetch({}) }));
  assert.strictEqual((await get('loadManualBars')()).length, 0, '404');
  ({ get } = load({ fetch: fakeFetch({ 'data/bars.json': new Error('weg') }) }));
  assert.strictEqual((await get('loadManualBars')()).length, 0, 'netwerkfout');
});

test('loadBarsInstant: cache eerst, anders statisch + handmatig samengevoegd', async () => {
  const fetch = fakeFetch({
    'data/osm_bars.json': { body: { elements: [{ type: 'node', id: 1, lat: 51.0257, lon: 4.4776, tags: { amenity: 'bar' } }] } },
    'data/bars.json': { body: [{ id: 'm-dubbel', lat: 51.0257, lon: 4.4776, amenity: 'bar' }, { id: 'm-ver', lat: 51.03, lon: 4.49, amenity: 'pub' }] },
  });
  const storage = fakeStorage();
  const { get } = load({ fetch, sessionStorage: storage });
  const out = plain(await get('loadBarsInstant')());
  assert.deepStrictEqual(out.map((b) => b.id), ['osm_node_1', 'm-ver']);

  get('cacheSet')(get('CACHE_KEY_BARS'), [{ id: 'uit-cache' }]);
  const n = fetch.calls.length;
  assert.deepStrictEqual(plain(await get('loadBarsInstant')()), [{ id: 'uit-cache' }]);
  assert.strictEqual(fetch.calls.length, n, 'geen fetch bij een cachetreffer');
});

test('_renderWeather en loadWeather: icoon, label, afronding; stil bij fout', async () => {
  const fetch = fakeFetch({ 'https://api.open-meteo.com/': { body: { current: { temperature_2m: 17.6, weather_code: 2, wind_speed_10m: 11.4 } } } });
  const { get, document } = load({ fetch });
  await get('loadWeather')();
  const el = document.els['weather-info'];
  assert.strictEqual(el.innerHTML, '⛅ Deels bewolkt · 18°C · 💨 11 km/h');
  assert.strictEqual(el.style.display, '');
  assert.match(fetch.calls[0], /latitude=51\.028&longitude=4\.480/);

  get('_renderWeather')(undefined, 999, undefined);
  assert.strictEqual(el.innerHTML, '🌡 Onbekend · --');

  const { get: get2, document: doc2 } = load({ fetch: fakeFetch({ 'https://api.open-meteo.com/': { ok: false, status: 500 } }) });
  await get2('loadWeather')();
  assert.strictEqual(doc2.els['weather-info'], undefined, 'niets gerenderd bij HTTP-fout');
  const { get: get3 } = load({ fetch: fakeFetch({ 'https://api.open-meteo.com/': new Error('weg') }) });
  await get3('loadWeather')(); // mag niet gooien
});

test('updateSunCompass: maan in het midden bij nacht, zonpositie op de cirkel overdag', () => {
  const { get, document } = load();
  const upd = get('updateSunCompass');
  upd({ isUp: false });
  const dot = document.els['sun-dot'];
  const label = document.els['sun-compass-label'];
  assert.strictEqual(dot.className, 'is-night');
  assert.strictEqual(dot.style.left, '50%');
  assert.strictEqual(label.textContent, '🌙 Nacht');

  // Zon in het oosten op de horizon: helemaal rechts (50 + 42).
  upd({ isUp: true, bearing: 90, altitude: 0, altitudeDeg: 0 });
  assert.strictEqual(dot.className, '');
  assert.strictEqual(dot.style.left, '92px');
  assert.strictEqual(dot.style.top, '50px');
  // Zon in het zenit: in het midden.
  upd({ isUp: true, bearing: 180, altitude: Math.PI / 2, altitudeDeg: 90 });
  assert.strictEqual(Math.round(parseFloat(dot.style.left)), 50);
  assert.strictEqual(Math.round(parseFloat(dot.style.top)), 50);
  assert.match(label.textContent, /90° hoogte/);
});

test('updateInfoPanel: tellers per zekerheid en de zonregel', () => {
  const { get, document } = load();
  get.context.__bars = [{ terrace: 'yes' }, { terrace: 'yes' }, { terrace: 'likely' }, { terrace: 'maybe' }, { terrace: 'no' }];
  get('allBars = __bars');
  const now = new Date(2026, 5, 21, 14, 0);
  const sun = { isUp: true, altitudeDeg: 55.4, bearing: 200 };

  get('updateInfoPanel')(sun, 2, 3, now);
  let counts = document.els['bar-counts'].innerHTML;
  assert.match(counts, /<strong>5<\/strong> bars gevonden/);
  assert.match(counts, /✅ 2/);
  assert.match(counts, /🟡 1/);
  assert.match(counts, /⚪ 1/);
  assert.match(counts, /Schaduwberekening laden/);
  assert.match(document.els['sun-info'].textContent, /55° hoogte/);

  get('buildingsReady = true');
  get('updateInfoPanel')(sun, 2, 3, now);
  counts = document.els['bar-counts'].innerHTML;
  assert.match(counts, /2 van 3 getoond in de zon/);

  get('updateInfoPanel')({ isUp: false }, 0, 3, now);
  assert.match(document.els['sun-info'].textContent, /onder de horizon/);
  assert.ok(!document.els['bar-counts'].innerHTML.includes('<br>'));
});

test('getFilters, showLoading, _setShadowToggleReady en tickClock lezen en schrijven de DOM', () => {
  const { get, document } = load();
  document.getElementById('filter-sunny').checked = true;
  document.getElementById('filter-confidence').value = '2';
  assert.deepStrictEqual(plain(get('getFilters')()), { onlySunny: true, onlyOpen: false, minConfidence: 2 });
  get("openFilter = 'open'");
  assert.strictEqual(get('getFilters')().onlyOpen, true);

  get('showLoading')(true, 'Bezig');
  assert.strictEqual(document.els.loading.style.display, 'flex');
  assert.strictEqual(document.els['loading-text'].textContent, 'Bezig');
  get('showLoading')(false);
  assert.strictEqual(document.els.loading.style.display, 'none');

  get('_setShadowToggleReady')();
  assert.strictEqual(document.els['shadow-toggle-text'].textContent, 'Toon zonschaduwen');
  assert.strictEqual(document.els['shadow-toggle-wrap'].attrs.title, undefined);

  get('tickClock')();
  assert.match(document.els['current-time'].textContent, /\d{2}.\d{2}.\d{2}/);

  get('updateSliderFill')();
  assert.strictEqual(document.els['filter-confidence'].style['--pct'], `${(2 / 3) * 100}%`);
});

test('runUpdate: nacht zet alles uit de zon, zonder gebouwen is de zon onbekend', () => {
  const { get, document } = load();
  get.context.__bars = [{ id: 'a', lat: 51.0257, lon: 4.4776, terrace: 'yes', opening_hours: '24/7' }, { id: 'b', lat: 51.0258, lon: 4.4777, terrace: 'likely' }];
  get('allBars = __bars');

  get.context.getSunPosition = () => ({ isUp: false, bearing: 0, altitude: -0.2, altitudeDeg: -10 });
  get('getSunPosition = window.getSunPosition');
  get('runUpdate')();
  let bars = plain(get('allBars'));
  assert.deepStrictEqual(bars.map((b) => [b.inSun, b._isNight, b.isOpen]), [[false, true, true], [false, true, null]]);
  assert.match(document.els['last-updated'].textContent, /^Bijgewerkt om /);

  get.context.getSunPosition = () => ({ isUp: true, bearing: 180, altitude: 0.8, altitudeDeg: 45 });
  get('runUpdate')();
  bars = plain(get('allBars'));
  assert.deepStrictEqual(bars.map((b) => [b.inSun, b._isNight]), [[null, false], [null, false]]);

  get('buildingsReady = true; allBuildings = []');
  get('runUpdate')();
  bars = plain(get('allBars'));
  assert.deepStrictEqual(bars.map((b) => b.inSun), [true, true], 'geen gebouwen: in de zon');
});

test('fetchBuildingsBackground: uit de cache of via Overpass, en de schaduwknop wordt actief', async () => {
  const storage = fakeStorage();
  const { get, document } = load({ sessionStorage: storage, fetch: fakeFetch({}), setTimeout: unrefTimeout, clearTimeout, AbortController });
  get.context.getSunPosition = () => ({ isUp: false, bearing: 0, altitude: -0.2, altitudeDeg: -10 });
  get('getSunPosition = window.getSunPosition');

  get('cacheSet')(get('CACHE_KEY_BUILDINGS'), [{ id: 'gebouw-uit-cache' }]);
  await get('fetchBuildingsBackground')();
  assert.strictEqual(get('buildingsReady'), true);
  assert.deepStrictEqual(plain(get('allBuildings')), [{ id: 'gebouw-uit-cache' }]);
  assert.strictEqual(document.els['shadow-toggle-text'].textContent, 'Toon zonschaduwen');

  // Geen cache en alle mirrors weg: niets verandert, geen fout.
  const { get: get2 } = load({ fetch: fakeFetch({}), setTimeout: unrefTimeout, clearTimeout, AbortController });
  await get2('fetchBuildingsBackground')();
  assert.strictEqual(get2('buildingsReady'), false);
});
