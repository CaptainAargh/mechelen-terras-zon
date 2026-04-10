// ─── Main application ──────────────────────────────────────────────────────

const CACHE_KEY_BARS      = 'mtz_bars_v2';
const CACHE_KEY_BUILDINGS = 'mtz_buildings_v2';
const CACHE_DURATION_MS   = 30 * 60 * 1000; // 30 min

const SUN_UPDATE_MS = 5 * 60 * 1000; // 5 min

let allBars      = [];
let allBuildings = []; // may stay empty if Overpass is unavailable
let buildingsReady = false;

// ─── Init ──────────────────────────────────────────────────────────────────

async function init() {
  initMap();

  // ── Phase 1: load bars instantly from bundled static snapshot ──
  showLoading(true, 'Terrassen laden…');
  try {
    allBars = await loadBarsInstant();
    console.log(`${allBars.length} terrassen geladen (statisch)`);
  } catch (err) {
    console.error('Kon statische bars niet laden:', err);
  }

  // Render bars right away (shadow status unknown → grey markers)
  runUpdate();
  showLoading(false);

  // Start clock + periodic sun recalc
  setInterval(tickClock, 1000);
  setInterval(runUpdate, SUN_UPDATE_MS);

  // ── Phase 2: fetch live data + buildings in background ──
  loadLiveDataInBackground();
}

// ─── Phase 1: instant bar loading ─────────────────────────────────────────

async function loadBarsInstant() {
  // 1. Try sessionStorage cache (has Overpass data from a previous visit)
  const cached = cacheGet(CACHE_KEY_BARS);
  if (cached) return cached;

  // 2. Fall back to bundled static JSON + manual additions
  const [staticBars, manualBars] = await Promise.all([
    fetchStaticBars(),
    loadManualBars(),
  ]);
  return mergeBars(staticBars, manualBars);
}

// ─── Phase 2: background live refresh ─────────────────────────────────────

async function loadLiveDataInBackground() {
  // Try buildings first (needed for shadow calc)
  fetchBuildingsBackground();

  // Try live bar refresh from Overpass (non-blocking)
  try {
    const cachedBars = cacheGet(CACHE_KEY_BARS);
    if (!cachedBars) {
      // Only attempt live fetch if we don't have a fresh cache
      const liveBars = await fetchBarsWithTerraces();
      if (liveBars) {
        const manualBars = await loadManualBars();
        const merged = mergeBars(liveBars, manualBars);
        cacheSet(CACHE_KEY_BARS, merged);
        allBars = merged;
        console.log(`${allBars.length} terrassen bijgewerkt via Overpass`);
        runUpdate();
      }
    }
  } catch (err) {
    console.warn('Live bar update mislukt (niet erg):', err.message);
  }
}

async function fetchBuildingsBackground() {
  // Use cached buildings if available
  const cached = cacheGet(CACHE_KEY_BUILDINGS);
  if (cached) {
    allBuildings  = cached;
    buildingsReady = true;
    console.log(`${allBuildings.length} gebouwen uit cache`);
    runUpdate();
    updateShadowStatus();
    return;
  }

  setBuildingStatus('Gebouwen ophalen voor schaduwberekening…');

  try {
    const buildings = await fetchBuildings();
    if (buildings && buildings.length > 0) {
      allBuildings   = buildings;
      buildingsReady = true;
      cacheSet(CACHE_KEY_BUILDINGS, buildings);
      console.log(`${allBuildings.length} gebouwen geladen`);
      runUpdate();
      updateShadowStatus();
    } else {
      setBuildingStatus('Schaduwberekening tijdelijk niet beschikbaar');
      console.warn('Gebouwen niet beschikbaar — schaduw wordt overgeslagen');
    }
  } catch (err) {
    setBuildingStatus('Schaduwberekening tijdelijk niet beschikbaar');
    console.warn('Gebouwen ophalen mislukt:', err.message);
  }
}

// ─── Update loop ───────────────────────────────────────────────────────────

function runUpdate() {
  const now    = new Date();
  const sunPos = getSunPosition(now);
  const onlySunny = document.getElementById('filter-sunny').checked;

  for (const bar of allBars) {
    bar._isNight = !sunPos.isUp;
    if (!sunPos.isUp) {
      bar.inSun = false;
    } else if (buildingsReady) {
      bar.inSun = isTerraceInSun(bar, allBuildings, sunPos);
    } else {
      bar.inSun = null; // unknown until buildings load
    }
  }

  const sunnyCount = updateBarMarkers(allBars, onlySunny);
  updateInfoPanel(sunPos, sunnyCount, now);

  document.getElementById('last-updated').textContent =
    `Bijgewerkt om ${now.toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' })}`;
}

// Called after buildings load to trigger a shadow recalc without changing the clock
function updateShadowStatus() {
  runUpdate();
}

// ─── Data helpers ──────────────────────────────────────────────────────────

async function loadManualBars() {
  try {
    const res = await fetch('data/bars.json');
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

function mergeBars(primary, manual) {
  const result = [...primary];
  for (const m of manual) {
    const dup = primary.some(p => {
      try {
        return turf.distance(
          turf.point([p.lon, p.lat]),
          turf.point([m.lon, m.lat]),
          { units: 'meters' }
        ) < 30;
      } catch { return false; }
    });
    if (!dup) result.push({ ...m, inSun: null, _isNight: false, source: 'manual' });
  }
  return result;
}

// ─── UI helpers ────────────────────────────────────────────────────────────

function tickClock() {
  const el = document.getElementById('current-time');
  if (el) el.textContent = new Date().toLocaleTimeString('nl-BE', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
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
    sunInfoEl.textContent =
      `☀️ ${Math.round(sunPos.altitudeDeg)}° hoogte · richting ${bearingToLabel(sunPos.bearing)}`;
    sunInfoEl.style.color = '';
  }

  const countEl = document.getElementById('sunny-count');
  if (!sunPos.isUp) {
    countEl.textContent = `${total} terrassen gevonden · momenteel nacht`;
  } else if (!buildingsReady) {
    countEl.textContent = `${total} terrassen gevonden · schaduw laden…`;
  } else if (total === 0) {
    countEl.textContent = 'Geen terrassen gevonden';
  } else {
    countEl.textContent = `${sunnyCount} van ${total} terrassen in de zon`;
  }
}

function setBuildingStatus(msg) {
  const el = document.getElementById('sunny-count');
  if (el) el.textContent = msg;
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

// ─── SessionStorage cache ──────────────────────────────────────────────────

function cacheGet(key) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    if (Date.now() - ts > CACHE_DURATION_MS) return null;
    return data;
  } catch { return null; }
}

function cacheSet(key, data) {
  try {
    sessionStorage.setItem(key, JSON.stringify({ data, ts: Date.now() }));
  } catch { /* storage full — ignore */ }
}

// ─── Events ────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  init();

  document.getElementById('filter-sunny').addEventListener('change', () => {
    updateBarMarkers(allBars, document.getElementById('filter-sunny').checked);
  });

  document.getElementById('show-buildings').addEventListener('change', e => {
    toggleBuildings(e.target.checked);
  });
});
