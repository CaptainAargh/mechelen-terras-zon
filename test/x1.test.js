// X1 (laptop-batch v12): de kaartopbouw van map.js met een nep-MapLibre, de opstart en achtergrondladers
// van app.js, de UI-handlers en een paar randen van hours.js. Geen netwerk: fetch, Overpass en MapLibre
// zijn nep; alles draait in de vm-context van test/load.js.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadScripts } = require('./load');

const plain = (x) => JSON.parse(JSON.stringify(x));
const quiet = { log() {}, warn() {}, error() {} };

/** Nep-MapLibre: één kaart die alles onthoudt wat map.js ermee doet. */
function fakeMaplibre({ styleLayers = [], images = [] } = {}) {
  const state = {
    sources: {}, layers: [], removed: [], handlers: {}, controls: [], paint: [], layout: [],
    images: new Set(images), added: [], popups: [], canvas: { style: { cursor: '' } }, options: null,
  };
  class Map {
    constructor(options) { state.options = options; state.map = this; }
    addControl(c, pos) { state.controls.push([c, pos]); }
    on(ev, a, b) { state.handlers[b ? `${ev}:${a}` : ev] = b || a; }
    getStyle() { return { layers: [...styleLayers, ...state.layers] }; }
    removeLayer(id) { state.removed.push(id); }
    addLayer(l) { state.layers.push(l); }
    addSource(id, s) { state.sources[id] = { ...s, setData(d) { this.data = d; } }; }
    getSource(id) { return state.sources[id]; }
    getLayer(id) { return state.layers.find((l) => l.id === id); }
    hasImage(id) { return state.images.has(id); }
    addImage(id, img) { state.images.add(id); state.added.push([id, img.width, img.height]); }
    setPaintProperty(id, p, v) { state.paint.push([id, p, v]); }
    setLayoutProperty(id, p, v) { state.layout.push([id, p, v]); }
    getCanvas() { return state.canvas; }
  }
  class Popup {
    constructor(opts) { this.opts = opts; state.popups.push(this); }
    setLngLat(c) { this.lngLat = c; return this; }
    setHTML(h) { this.html = h; return this; }
    addTo(m) { this.map = m; return this; }
  }
  return { state, lib: { Map, Popup, NavigationControl: class { constructor(o) { this.o = o; } } } };
}

function fakeCanvasDocument() {
  const ops = [];
  const ctx = new Proxy({}, {
    get: (_, k) => (k === 'getImageData' ? (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) : (...a) => ops.push([k, ...a])),
    set: () => true,
  });
  return { ops, createElement: (tag) => ({ tag, getContext: () => ctx }) };
}

function loadMap({ styleLayers, images } = {}) {
  const ml = fakeMaplibre({ styleLayers, images });
  const frames = [];
  const doc = fakeCanvasDocument();
  const get = loadScripts(['vendor/turf.min.js', 'js/hours.js', 'js/map.js'], {
    maplibregl: ml.lib, document: doc, requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
  });
  return { get, ml, frames, doc };
}

const BASE_LAYERS = [
  { id: 'labels', type: 'symbol' },
  { id: 'building-3d', type: 'fill-extrusion', 'source-layer': 'building' },
  { id: 'building-flat', type: 'fill', 'source-layer': 'building' },
  { id: 'water', type: 'fill', 'source-layer': 'water' },
];

test('initMap: kaart op Mechelen, navigatie rechtsonder, wacht op load', () => {
  const { get, ml } = loadMap();
  get('initMap')();
  assert.deepStrictEqual(plain(ml.state.options.center), [4.4776, 51.0257]);
  assert.strictEqual(ml.state.options.container, 'map');
  assert.strictEqual(ml.state.controls[0][1], 'bottom-right');
  assert.strictEqual(typeof ml.state.handlers.load, 'function');
  assert.strictEqual(get('isMapReady'), false);
});

test('styleimagemissing: voegt alleen een lege afbeelding toe als die echt ontbreekt', () => {
  const { get, ml } = loadMap({ images: ['al-daar'] });
  get('initMap')();
  const missing = ml.state.handlers.styleimagemissing;
  missing({ id: 'al-daar' });
  missing({ id: 'nieuw' });
  missing({});
  assert.deepStrictEqual(ml.state.added, [['nieuw', 1, 1]]);
});

test('load: vervangt de basis-3D-gebouwen, voegt bronnen en lagen toe en past de wachtrij toe', () => {
  const { get, ml, frames } = loadMap({ styleLayers: BASE_LAYERS });
  get('initMap')();
  // Een update voor de kaart klaar is, komt in de wachtrij.
  get('updateBarMarkers')([{ id: 'b1', name: 'B1', lat: 51, lon: 4.4, terrace: 'yes', inSun: true, isOpen: true }],
    { onlySunny: false, onlyOpen: false, minConfidence: 0 });
  assert.ok(get('pendingBars'));

  ml.state.handlers.load();
  assert.deepStrictEqual(ml.state.removed, ['building-3d'], 'alleen fill-extrusion van de basisstijl weg');
  const ids = ml.state.layers.map((l) => l.id);
  assert.ok(ids.includes('building-3d-custom'));
  assert.ok(ids.includes('bars-glow'));
  assert.deepStrictEqual(Object.keys(ml.state.sources).sort(), ['bars', 'shadows']);
  assert.ok(ml.state.added.some(([id, w, h]) => id === 'shadow-hatch' && w === 14 && h === 14));
  assert.strictEqual(get('isMapReady'), true);
  assert.strictEqual(get('pendingBars'), null);
  assert.deepStrictEqual(plain(ml.state.sources.bars.data.features.map((f) => f.properties.id)), ['b1']);

  // De gloed animeert: paint-eigenschappen gezet en een volgend frame gepland.
  assert.deepStrictEqual(ml.state.paint.map(([id, p]) => `${id}.${p}`), ['bars-glow.circle-opacity', 'bars-glow.circle-radius']);
  const [, , opacity] = ml.state.paint[0];
  assert.ok(opacity >= 0.08 && opacity <= 0.3);
  assert.strictEqual(frames.length, 1);
});

test('load: klik opent een popup op de bar, hover zet de cursor', () => {
  const { get, ml } = loadMap({ styleLayers: BASE_LAYERS });
  get('initMap')();
  ml.state.handlers.load();
  const feature = get('_barToFeature')({ id: 'x', name: 'Café Test', lat: 51.02, lon: 4.47, terrace: 'yes', inSun: true });
  ml.state.handlers['click:bars-circle']({ features: [feature] });
  const [popup] = ml.state.popups;
  assert.deepStrictEqual(plain(popup.lngLat), [4.47, 51.02]);
  assert.match(popup.html, /Café Test/);
  assert.strictEqual(popup.opts.className, 'bar-popup');
  ml.state.handlers['mouseenter:bars-circle']();
  assert.strictEqual(ml.state.canvas.style.cursor, 'pointer');
  ml.state.handlers['mouseleave:bars-circle']();
  assert.strictEqual(ml.state.canvas.style.cursor, '');
});

test('_addHatchPattern: tekent het patroon één keer', () => {
  const { get, ml, doc } = loadMap();
  get('initMap')();
  get('_addHatchPattern')();
  get('_addHatchPattern')();
  assert.strictEqual(ml.state.added.filter(([id]) => id === 'shadow-hatch').length, 1);
  assert.ok(doc.ops.some(([k]) => k === 'stroke'));
});

test('toggleBuildings: niets voor de kaart klaar is, daarna eigen laag en alle basisgebouwlagen', () => {
  const { get, ml } = loadMap({ styleLayers: BASE_LAYERS });
  get('toggleBuildings')(false); // nog geen kaart
  get('initMap')();
  get('toggleBuildings')(false); // kaart, maar nog niet geladen
  assert.deepStrictEqual(ml.state.layout, []);
  ml.state.handlers.load();
  get('toggleBuildings')(false);
  assert.deepStrictEqual(plain(ml.state.layout), [
    ['building-3d-custom', 'visibility', 'none'],
    ['building-3d', 'visibility', 'none'],
    ['building-flat', 'visibility', 'none'],
    ['building-3d-custom', 'visibility', 'none'],
  ]);
});

test('_computeShadowPolygon: te korte schaduw is null, anders een veelhoek', () => {
  const { get } = loadMap();
  const turf = get('turf');
  const building = { height: 10, polygon: turf.polygon([[[4.47, 51.02], [4.4702, 51.02], [4.4702, 51.0202], [4.47, 51.0202], [4.47, 51.02]]]) };
  assert.strictEqual(get('_computeShadowPolygon')({ ...building, height: 0.1 }, { bearing: 180, altitude: Math.PI / 4 }), null);
  const shadow = get('_computeShadowPolygon')(building, { bearing: 180, altitude: Math.PI / 6 });
  assert.strictEqual(shadow.geometry.type, 'Polygon');
});

// ─── app.js ─────────────────────────────────────────────────────────────────

function fakeDocument() {
  const els = {};
  const handlers = {};
  const pills = [];
  const labels = [0, 1, 2, 3].map(() => ({ style: {} }));
  const el = (id) => {
    if (!els[id]) {
      els[id] = {
        id, textContent: '', innerHTML: '', className: '', checked: false, value: '2', attrs: { title: 'x' },
        style: { setProperty(k, v) { this[k] = v; } }, listeners: {},
        removeAttribute(a) { delete this.attrs[a]; },
        addEventListener(ev, fn) { this.listeners[ev] = fn; },
      };
    }
    return els[id];
  };
  for (const open of ['all', 'open']) {
    pills.push({
      dataset: { open }, listeners: {}, classes: new Set(open === 'all' ? ['active'] : []),
      addEventListener(ev, fn) { this.listeners[ev] = fn; },
      get classList() { const c = this.classes; return { add: (x) => c.add(x), remove: (x) => c.delete(x) }; },
    });
  }
  return {
    els, handlers, pills, labels,
    getElementById: el,
    querySelectorAll: (sel) => (sel === '.pill[data-open]' ? pills : sel === '#confidence-labels span' ? labels : []),
    addEventListener: (ev, fn) => { handlers[ev] = fn; },
  };
}

function fakeStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
}

function loadApp(globals = {}) {
  const document = fakeDocument();
  const intervals = [];
  const get = loadScripts(
    ['vendor/suncalc.js', 'vendor/turf.min.js', 'js/osm.js', 'js/hours.js', 'js/sun.js', 'js/map.js', 'js/app.js'],
    { console: quiet, sessionStorage: fakeStorage(), Date, setInterval: (fn, ms) => intervals.push([fn.name, ms]), ...globals, document },
  );
  // Alles wat naar buiten gaat, vervangen in de globale scope van de context.
  const calls = [];
  const stub = (name, impl) => { get.context[name] = (...a) => { calls.push(name); return impl(...a); }; };
  stub('initMap', () => {});
  stub('loadWeather', async () => {});
  stub('updateBarMarkers', (bars) => ({ sunnyCount: 0, shownCount: bars.length }));
  stub('updateShadowOverlay', () => {});
  stub('toggleBuildings', () => {});
  return { get, document, intervals, calls, stub };
}

const flush = () => new Promise((r) => setImmediate(r));

test('init: laadt statische bars, start klok, zon-update en weer, en laadt live data op de achtergrond', async () => {
  const { get, document, intervals, calls, stub } = loadApp();
  stub('fetchStaticBars', async () => [{ id: 's1', name: 'S1', lat: 51.02, lon: 4.47 }]);
  stub('loadManualBars', async () => []);
  stub('fetchBuildings', async () => []);
  stub('fetchBarsWithTerraces', async () => null);
  await get('init')();
  await flush();
  assert.strictEqual(get('allBars').length, 1);
  assert.strictEqual(document.els.loading.style.display, 'none');
  assert.strictEqual(document.els['shadow-toggle-text'].textContent, 'Toon zonschaduwen (laden…)');
  assert.deepStrictEqual(intervals.map(([, ms]) => ms), [1000, 5 * 60 * 1000, 30 * 60 * 1000]);
  assert.ok(calls.includes('initMap'));
  assert.ok(calls.includes('fetchBarsWithTerraces'));
  assert.match(document.els['last-updated'].textContent, /^Bijgewerkt om /);
});

test('init: een fout bij de statische bars stopt de opstart niet', async () => {
  const { get, document, stub } = loadApp();
  stub('fetchStaticBars', async () => { throw new Error('weg'); });
  stub('loadManualBars', async () => []);
  stub('fetchBuildings', async () => []);
  stub('fetchBarsWithTerraces', async () => null);
  await get('init')();
  assert.strictEqual(get('allBars').length, 0);
  assert.strictEqual(document.els.loading.style.display, 'none');
});

test('loadLiveDataInBackground: live bars samengevoegd, in de cache en zichtbaar', async () => {
  const storage = fakeStorage();
  const { get, stub } = loadApp({ sessionStorage: storage });
  stub('fetchBuildings', async () => []);
  stub('fetchBarsWithTerraces', async () => [{ id: 'live', name: 'Live', lat: 51.02, lon: 4.47 }]);
  stub('loadManualBars', async () => [{ id: 'eigen', name: 'Eigen', lat: 51.03, lon: 4.49 }]);
  await get('loadLiveDataInBackground')();
  assert.deepStrictEqual(plain(get('allBars').map((b) => b.id)), ['live', 'eigen']);
  assert.ok(storage.m.has('mtz_bars_v3'));
});

test('loadLiveDataInBackground: met verse cache geen Overpass; een fout wordt alleen gemeld', async () => {
  const cached = JSON.stringify({ data: [{ id: 'c' }], ts: Date.now() });
  const a = loadApp({ sessionStorage: fakeStorage({ mtz_bars_v3: cached }) });
  a.stub('fetchBuildings', async () => []);
  a.stub('fetchBarsWithTerraces', async () => { throw new Error('mag niet'); });
  await a.get('loadLiveDataInBackground')();
  assert.ok(!a.calls.includes('fetchBarsWithTerraces'));

  const b = loadApp();
  b.stub('fetchBuildings', async () => []);
  b.stub('fetchBarsWithTerraces', async () => { throw new Error('Overpass 504'); });
  await b.get('loadLiveDataInBackground')();
  assert.deepStrictEqual(plain(b.get('allBars')), []);
});

test('fetchBuildingsBackground: vers geladen gebouwen gaan in de cache en zetten de schaduwknop klaar', async () => {
  const storage = fakeStorage();
  const { get, stub, document } = loadApp({ sessionStorage: storage });
  stub('fetchBuildings', async () => [{ id: 'g1', height: 10 }]);
  await get('fetchBuildingsBackground')();
  assert.strictEqual(get('buildingsReady'), true);
  assert.ok(storage.m.has('mtz_buildings_v3'));
  assert.strictEqual(document.els['shadow-toggle-text'].textContent, 'Toon zonschaduwen');
});

test('fetchBuildingsBackground: leeg resultaat of een fout laat de schaduwen uit', async () => {
  for (const impl of [async () => [], async () => { throw new Error('Overpass weg'); }]) {
    const { get, stub } = loadApp();
    stub('fetchBuildings', impl);
    await get('fetchBuildingsBackground')();
    assert.strictEqual(get('buildingsReady'), false);
  }
});

test('updateSliderFill: kleurt het label van de gekozen zekerheid', () => {
  const { get, document } = loadApp();
  get('updateSliderFill')();
  assert.strictEqual(document.els['filter-confidence'].style['--pct'], `${(2 / 3) * 100}%`);
  assert.deepStrictEqual(document.labels.map((l) => l.style.fontWeight), ['', '', '700', '']);
});

test('DOMContentLoaded: filters, gebouwen, schaduwen en de open-knoppen werken', async () => {
  const { get, document, calls, stub } = loadApp();
  stub('fetchStaticBars', async () => []);
  stub('loadManualBars', async () => []);
  stub('fetchBuildings', async () => []);
  stub('fetchBarsWithTerraces', async () => null);
  document.handlers.DOMContentLoaded();
  await flush();

  calls.length = 0;
  document.els['filter-confidence'].listeners.input();
  document.els['filter-sunny'].listeners.change();
  assert.strictEqual(calls.filter((c) => c === 'updateBarMarkers').length, 2);

  document.els['show-buildings'].listeners.change({ target: { checked: true } });
  assert.ok(calls.includes('toggleBuildings'));

  document.els['show-shadows'].listeners.change({ target: { checked: true } });
  assert.strictEqual(get('shadowsEnabled'), true);

  const [all, open] = document.pills;
  open.listeners.click();
  assert.strictEqual(get('openFilter'), 'open');
  assert.ok(open.classes.has('active'));
  assert.ok(!all.classes.has('active'));
});

// ─── hours.js ───────────────────────────────────────────────────────────────

test('isOpenNow: dagbereik over het weekend heen (fr-mo) en een onbekende dag', () => {
  const get = loadScripts(['js/hours.js']);
  const isOpen = get('isOpenNow');
  const at = (y, m, d, h) => new Date(y, m - 1, d, h, 0);
  // 2026-11-23 is een maandag, 2026-11-25 een woensdag.
  assert.strictEqual(isOpen('Fr-Mo 10:00-22:00', at(2026, 11, 23, 12)), true);
  assert.strictEqual(isOpen('Fr-Mo 10:00-22:00', at(2026, 11, 25, 12)), false);
  assert.strictEqual(isOpen('Xx-Mo 10:00-22:00', at(2026, 11, 23, 12)), null);
});
