// ─── Main application ──────────────────────────────────────────────────────

// sessionStorage keys
const CACHE_KEY_BARS      = 'mtz_bars_v1';
const CACHE_KEY_BUILDINGS = 'mtz_buildings_v1';
const CACHE_DURATION_MS   = 30 * 60 * 1000; // 30 minutes

// Update interval (ms)
const SUN_UPDATE_MS = 5 * 60 * 1000; // 5 minutes

let allBars      = [];
let allBuildings = [];
let sunUpdateTimer = null;

// ─── Initialisation ────────────────────────────────────────────────────────

async function init() {
  initMap();
  showLoading(true, 'Terrassen & gebouwen ophalen…');

  try {
    // Fetch bars and buildings in parallel, using sessionStorage cache
    [allBars, allBuildings] = await Promise.all([
      loadBars(),
      loadBuildings(),
    ]);

    console.log(`Geladen: ${allBars.length} terrassen, ${allBuildings.length} gebouwen`);

    // Render building outlines (hidden by default, toggle via checkbox)
    renderBuildings(allBuildings);

    // Initial sun status computation + map render
    runUpdate();

    // Schedule regular sun-status updates
    sunUpdateTimer = setInterval(runUpdate, SUN_UPDATE_MS);

    // Tick the clock every second
    setInterval(tickClock, 1000);

  } catch (err) {
    console.error(err);
    showError(`Kon data niet laden: ${err.message}`);
  } finally {
    showLoading(false);
  }
}

// ─── Update loop ───────────────────────────────────────────────────────────

function runUpdate() {
  const now = new Date();
  const sunPos = getSunPosition(now);
  const onlySunny = document.getElementById('filter-sunny').checked;

  // Compute sun status for every bar
  for (const bar of allBars) {
    bar._isNight = !sunPos.isUp;
    bar.inSun    = sunPos.isUp ? isTerraceInSun(bar, allBuildings, sunPos) : false;
  }

  const sunnyCount = updateBarMarkers(allBars, onlySunny);
  updateInfoPanel(sunPos, sunnyCount, now);
  document.getElementById('last-updated').textContent =
    `Bijgewerkt om ${now.toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' })}`;
}

// ─── Data loading (with cache) ─────────────────────────────────────────────

async function loadBars() {
  const cached = cacheGet(CACHE_KEY_BARS);
  if (cached) {
    console.log('Terrassen uit cache geladen');
    return cached;
  }

  const [osmBars, manualBars] = await Promise.all([
    fetchBarsWithTerraces(),
    loadManualBars(),
  ]);

  const merged = mergeBars(osmBars, manualBars);
  cacheSet(CACHE_KEY_BARS, merged);
  return merged;
}

async function loadBuildings() {
  const cached = cacheGet(CACHE_KEY_BUILDINGS);
  if (cached) {
    // Re-create turf polygon objects from plain GeoJSON (lost during JSON serialisation)
    return cached.map(b => ({
      ...b,
      polygon: b.polygon, // turf accepts plain GeoJSON Feature objects
    }));
  }

  const buildings = await fetchBuildings();
  cacheSet(CACHE_KEY_BUILDINGS, buildings);
  return buildings;
}

async function loadManualBars() {
  try {
    const res = await fetch('data/bars.json');
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

/**
 * Merge OSM bars with manually added bars.
 * Manual bars within 30m of an OSM bar are considered duplicates and skipped.
 */
function mergeBars(osmBars, manualBars) {
  const result = [...osmBars];

  for (const manual of manualBars) {
    const isDuplicate = osmBars.some(osm => {
      try {
        const dist = turf.distance(
          turf.point([osm.lon, osm.lat]),
          turf.point([manual.lon, manual.lat]),
          { units: 'meters' }
        );
        return dist < 30;
      } catch {
        return false;
      }
    });

    if (!isDuplicate) {
      result.push({
        ...manual,
        inSun: false,
        _isNight: false,
        source: 'manual',
      });
    }
  }

  return result;
}

// ─── UI helpers ────────────────────────────────────────────────────────────

function tickClock() {
  const now = new Date();
  const el = document.getElementById('current-time');
  if (el) {
    el.textContent = now.toLocaleTimeString('nl-BE', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }
}

function updateInfoPanel(sunPos, sunnyCount, now) {
  const total = allBars.length;

  document.getElementById('current-date').textContent =
    now.toLocaleDateString('nl-BE', { weekday: 'long', day: 'numeric', month: 'long' });

  const sunInfoEl = document.getElementById('sun-info');
  if (!sunPos.isUp) {
    sunInfoEl.textContent = '🌙 Zon staat onder de horizon';
    sunInfoEl.style.color = '#8891b4';
  } else {
    const dir = bearingToLabel(sunPos.bearing);
    sunInfoEl.textContent =
      `☀️ ${Math.round(sunPos.altitudeDeg)}° hoogte · richting ${dir}`;
    sunInfoEl.style.color = '';
  }

  const countEl = document.getElementById('sunny-count');
  if (!sunPos.isUp) {
    countEl.textContent = `${total} terrassen gevonden · momenteel nacht`;
  } else if (total === 0) {
    countEl.textContent = 'Geen terrassen gevonden';
  } else {
    countEl.textContent = `${sunnyCount} van ${total} terrassen in de zon`;
  }
}

function showLoading(show, text) {
  const el = document.getElementById('loading');
  if (!el) return;
  el.style.display = show ? 'flex' : 'none';
  if (text) {
    const t = document.getElementById('loading-text');
    if (t) t.textContent = text;
  }
}

function showError(msg) {
  const el = document.getElementById('error');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
}

// ─── SessionStorage cache ──────────────────────────────────────────────────

function cacheGet(key) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    if (Date.now() - ts > CACHE_DURATION_MS) return null;
    return data;
  } catch {
    return null;
  }
}

function cacheSet(key, data) {
  try {
    sessionStorage.setItem(key, JSON.stringify({ data, ts: Date.now() }));
  } catch {
    // sessionStorage full or unavailable — ignore
  }
}

// ─── Event wiring ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  init();

  document.getElementById('filter-sunny').addEventListener('change', () => {
    // Re-render markers with new filter, no recalculation needed
    const onlySunny = document.getElementById('filter-sunny').checked;
    updateBarMarkers(allBars, onlySunny);
  });

  document.getElementById('show-buildings').addEventListener('change', e => {
    toggleBuildings(e.target.checked);
  });
});
