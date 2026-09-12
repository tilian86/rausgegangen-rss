'use strict';

/* ============================================================
   Platzkarte – offizieller Lageplan + live GPS-Position
   Alles lokal: kein Server, keine Konten, kein Tracking.
   ============================================================ */

const APP_VERSION = '1.0.0';
const LS_KEY = 'campmap.state.v1';
const IDB_NAME = 'campmap';
const IDB_STORE = 'blobs';

/* ---------- Geo-Mathematik ------------------------------------
   Kalibrierung = affine Abbildung zwischen einer lokalen
   Meter-Ebene (Ost / Süd, Ursprung am ersten Kalibrierpunkt)
   und den Pixelkoordinaten des Planbildes.
   -------------------------------------------------------------- */

const M_PER_DEG_LAT = 111132.95;
const M_PER_DEG_LON = 111319.49;

function project(lat, lon, ref) {
  const k = Math.cos(ref.lat * Math.PI / 180);
  return {
    x: (lon - ref.lon) * M_PER_DEG_LON * k,   // Ost
    y: -(lat - ref.lat) * M_PER_DEG_LAT       // Süd (wie Bild-y nach unten)
  };
}

function unproject(x, y, ref) {
  const k = Math.cos(ref.lat * Math.PI / 180);
  return {
    lat: ref.lat - y / M_PER_DEG_LAT,
    lon: ref.lon + x / (M_PER_DEG_LON * k)
  };
}

function applyTransform(T, mx, my) {
  return { px: T.a * mx + T.b * my + T.c, py: T.d * mx + T.e * my + T.f };
}

function invertTransform(T, px, py) {
  const det = T.a * T.e - T.b * T.d;
  const dx = px - T.c, dy = py - T.f;
  return { mx: (T.e * dx - T.b * dy) / det, my: (-T.d * dx + T.a * dy) / det };
}

/* Ähnlichkeitstransformation (Drehung + gleichmäßige Skalierung +
   Verschiebung) als Kleinste-Quadrate-Lösung. Exakt bei 2 Punkten. */
function solveSimilarity(pts) {
  const n = pts.length;
  if (n < 2) return null;
  let mmx = 0, mmy = 0, mpx = 0, mpy = 0;
  for (const p of pts) { mmx += p.mx; mmy += p.my; mpx += p.px; mpy += p.py; }
  mmx /= n; mmy /= n; mpx /= n; mpy /= n;

  let sc = 0, ss = 0, norm = 0;
  for (const p of pts) {
    const ax = p.mx - mmx, ay = p.my - mmy;
    const bx = p.px - mpx, by = p.py - mpy;
    sc += bx * ax + by * ay;
    ss += by * ax - bx * ay;
    norm += ax * ax + ay * ay;
  }
  if (norm < 1e-9) return null;
  const s = Math.hypot(sc, ss) / norm;
  if (!(s > 0) || !isFinite(s)) return null;
  const ang = Math.atan2(ss, sc);
  const a = s * Math.cos(ang), b = -s * Math.sin(ang);
  const d = s * Math.sin(ang), e = s * Math.cos(ang);
  return {
    a, b, d, e,
    c: mpx - (a * mmx + b * mmy),
    f: mpy - (d * mmx + e * mmy),
    kind: 'similarity'
  };
}

/* Volle affine Abbildung (6 Parameter) per Normalgleichungen.
   Gleicht auch ungleiche Maßstäbe und Scherung im Plan aus. */
function solveAffine(pts) {
  if (pts.length < 3) return null;
  // N * [a b c]^T = rx   mit Basis [mx, my, 1]
  const N = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const rx = [0, 0, 0], ry = [0, 0, 0];
  for (const p of pts) {
    const v = [p.mx, p.my, 1];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) N[i][j] += v[i] * v[j];
      rx[i] += v[i] * p.px;
      ry[i] += v[i] * p.py;
    }
  }
  const sx = solve3(N, rx), sy = solve3(N, ry);
  if (!sx || !sy) return null;
  const T = { a: sx[0], b: sx[1], c: sx[2], d: sy[0], e: sy[1], f: sy[2], kind: 'affine' };

  // Plausibilität: keine Spiegelung, keine extreme Scherung.
  const det = T.a * T.e - T.b * T.d;
  if (!(det > 0)) return null;
  const E = (T.a + T.e) / 2, F = (T.a - T.e) / 2;
  const G = (T.d + T.b) / 2, H = (T.d - T.b) / 2;
  const s1 = Math.hypot(E, H) + Math.hypot(F, G);
  const s2 = Math.abs(Math.hypot(E, H) - Math.hypot(F, G));
  if (!(s2 > 0) || s1 / s2 > 1.6) return null;
  return T;
}

function solve3(M, r) {
  // Gauß mit Spaltenpivotisierung auf einer Kopie
  const A = [[M[0][0], M[0][1], M[0][2], r[0]],
             [M[1][0], M[1][1], M[1][2], r[1]],
             [M[2][0], M[2][1], M[2][2], r[2]]];
  const scale = Math.max(1e-12, Math.abs(A[0][0]) + Math.abs(A[1][1]) + Math.abs(A[2][2]));
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let row = col + 1; row < 3; row++) {
      if (Math.abs(A[row][col]) > Math.abs(A[piv][col])) piv = row;
    }
    if (Math.abs(A[piv][col]) < 1e-9 * scale) return null;  // singulär / kollinear
    if (piv !== col) { const t = A[piv]; A[piv] = A[col]; A[col] = t; }
    for (let row = 0; row < 3; row++) {
      if (row === col) continue;
      const k = A[row][col] / A[col][col];
      for (let j = col; j < 4; j++) A[row][j] -= k * A[col][j];
    }
  }
  return [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]];
}

/* points: [{px, py, lat, lon}] -> Transform inkl. Gütemaßen.
   Wichtig: Bei genau 3 Punkten geht die affine Lösung exakt durch alle
   Punkte, der Restfehler ist dann immer 0 und sagt nichts über die
   Genauigkeit. Aussagekräftig ist erst der Kontrollfehler: jeden Punkt
   einmal weglassen, aus dem Rest rechnen und schauen, wie weit die
   Vorhersage danebenliegt. */
function solveTransform(points, withCheck = true) {
  if (!points || points.length < 2) return null;
  const ref = { lat: points[0].lat, lon: points[0].lon };
  const pts = points.map(p => {
    const m = project(p.lat, p.lon, ref);
    return { px: p.px, py: p.py, mx: m.x, my: m.y };
  });

  let T = points.length >= 3 ? solveAffine(pts) : null;
  const fellBack = !T && points.length >= 3;
  if (!T) T = solveSimilarity(pts);
  if (!T) return null;

  T.ref = ref;
  T.n = points.length;
  T.fellBack = fellBack;
  const det = T.a * T.e - T.b * T.d;
  T.pxPerMeter = Math.sqrt(Math.abs(det));
  if (!isFinite(T.pxPerMeter) || T.pxPerMeter <= 0) return null;

  let sum = 0, max = 0;
  T.residuals = pts.map(p => {
    const q = applyTransform(T, p.mx, p.my);
    const err = Math.hypot(q.px - p.px, q.py - p.py) / T.pxPerMeter;
    sum += err * err;
    if (err > max) max = err;
    return err;
  });
  T.rms = Math.sqrt(sum / pts.length);
  T.maxErr = max;

  // Richtung, in die Nord im Bild zeigt (0° = Bild oben, im Uhrzeigersinn)
  T.northDeg = (Math.atan2(-T.b, T.e) * 180 / Math.PI + 360) % 360;

  if (withCheck && points.length >= 3) {
    const errs = points.map((p, i) => {
      const rest = points.filter((_, j) => j !== i);
      const T2 = solveTransform(rest, false);
      if (!T2) return null;
      const q = latLonToPlan(T2, p.lat, p.lon);
      return Math.hypot(q.px - p.px, q.py - p.py) / T2.pxPerMeter;
    });
    const ok = errs.filter(e => e != null);
    T.checkErrors = errs;
    T.check = ok.length
      ? { mean: ok.reduce((a, b) => a + b, 0) / ok.length, max: Math.max(...ok) }
      : null;
  } else {
    T.checkErrors = null;
    T.check = null;
  }
  return T;
}

function latLonToPlan(T, lat, lon) {
  const m = project(lat, lon, T.ref);
  return applyTransform(T, m.x, m.y);
}

function planToLatLon(T, px, py) {
  const m = invertTransform(T, px, py);
  return unproject(m.mx, m.my, T.ref);
}

function geoDistance(lat1, lon1, lat2, lon2) {
  const R = 6371008.8;
  const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
  const dp = p2 - p1, dl = (lon2 - lon1) * Math.PI / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
  const dl = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/* Akzeptiert "45.2938, 13.5897", "45,2938 13,5897",
   "45°17'37.7\"N 13°35'22.9\"E", "N 45 17.63 E 13 35.38" */
function parseCoords(input) {
  if (!input) return null;
  const s = String(input).trim().replace(/\s+/g, ' ');

  // Rein dezimal: nacheinander plausible Trennzeichen probieren.
  if (!/[a-zA-Z°'"′″]/.test(s)) {
    const splits = [/,\s+|;\s*/, /\s+/, /,/];
    for (const sep of splits) {
      const parts = s.split(sep);
      if (parts.length !== 2) continue;
      const lat = parseFloat(parts[0].replace(',', '.'));
      const lon = parseFloat(parts[1].replace(',', '.'));
      const ok = validCoords(lat, lon);
      if (ok) return ok;
    }
    return null;
  }

  const parts = [];
  const re = /([NSEWnsewOo])?\s*(\d+(?:[.,]\d+)?)\s*(?:°|deg|\s)?\s*(?:(\d+(?:[.,]\d+)?)\s*['′m]?)?\s*(?:(\d+(?:[.,]\d+)?)\s*["″s]?)?\s*([NSEWnsewOo])?/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (!m[2]) continue;
    const deg = parseFloat(m[2].replace(',', '.'));
    const min = m[3] ? parseFloat(m[3].replace(',', '.')) : 0;
    const sec = m[4] ? parseFloat(m[4].replace(',', '.')) : 0;
    const hemi = (m[1] || m[5] || '').toUpperCase();
    let val = deg + min / 60 + sec / 3600;
    if (hemi === 'S' || hemi === 'W') val = -val;
    parts.push({ val, hemi });
    if (parts.length === 2) break;
  }
  if (parts.length === 2) {
    let [p, q] = parts;
    if (['E', 'W', 'O'].includes(p.hemi) || ['N', 'S'].includes(q.hemi)) { const t = p; p = q; q = t; }
    return validCoords(p.val, q.val);
  }
  return null;
}

function validCoords(lat, lon) {
  if (!isFinite(lat) || !isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

const COMPASS_NAMES = ['N', 'NNO', 'NO', 'ONO', 'O', 'OSO', 'SO', 'SSO', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
function compassName(deg) {
  return COMPASS_NAMES[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

window.CampMath = {
  project, unproject, applyTransform, invertTransform,
  solveTransform, solveAffine, solveSimilarity,
  latLonToPlan, planToLatLon, geoDistance, bearingDeg, parseCoords, compassName
};

/* ---------- Zustand ------------------------------------------ */

const state = {
  plan: null,            // {name, w, h}
  calib: [],             // [{id, u, v, lat, lon, acc, ts}]
  markers: [],           // [{id, u, v, name, icon}]
  targetId: null,
  opts: { compass: false, keepAwake: false },
  // flüchtig:
  T: null,
  pos: null,             // {lat, lon, acc, ts}
  heading: null,
  follow: true,
  mode: null,            // null | {type:'calib'|'calib-manual'|'marker'}
  geoError: null,
  planUrl: null
};

const view = { x: 0, y: 0, z: 1, fit: 1 };

const $ = sel => document.querySelector(sel);
const el = {
  stage: $('#stage'), world: $('#world'), plan: $('#plan'),
  me: $('#me'), meArrow: $('#me .me-arrow'), acc: $('#accuracy'),
  markers: $('#markers'), calibpts: $('#calibpts'),
  status: $('#status'), compass: $('#compass'), banner: $('#banner'),
  scalebar: $('#scalebar'), scaletext: $('#scaletext'),
  targetbar: $('#targetbar'), targetName: $('#target-name'),
  targetDist: $('#target-dist'), targetArrow: $('#target-arrow'),
  toolbar: $('#toolbar'), btnFollow: $('#btn-follow'), btnMarker: $('#btn-marker'), btnCalib: $('#btn-calib'),
  modebar: $('#modebar'), modetext: $('#modetext'),
  welcome: $('#welcome'), sheet: $('#sheet'), dialog: $('#dialog'), actions: $('#actions'),
  filePlan: $('#file-plan'), fileImport: $('#file-import')
};

/* ---------- Speicher ----------------------------------------- */

function saveState() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      v: 1, plan: state.plan, calib: state.calib,
      markers: state.markers, targetId: state.targetId, opts: state.opts
    }));
  } catch (err) { console.warn('Speichern fehlgeschlagen', err); }
}

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    state.plan = s.plan || null;
    state.calib = Array.isArray(s.calib) ? s.calib : [];
    state.markers = Array.isArray(s.markers) ? s.markers : [];
    state.targetId = s.targetId || null;
    state.opts = Object.assign(state.opts, s.opts || {});
  } catch (err) { console.warn('Laden fehlgeschlagen', err); }
}

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/* ---------- Plan laden --------------------------------------- */

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Bild konnte nicht gelesen werden'));
    img.src = src;
  });
}

async function setPlanFromBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  let img;
  try {
    img = await loadImage(url);
  } catch (err) {
    URL.revokeObjectURL(url);
    showBanner('Diese Datei konnte nicht als Bild gelesen werden. Bei PDFs: Screenshot machen oder als JPG/PNG exportieren.', 'bad');
    return false;
  }
  if (state.planUrl) URL.revokeObjectURL(state.planUrl);
  state.planUrl = url;
  state.plan = { name: name || 'Lageplan', w: img.naturalWidth, h: img.naturalHeight };
  el.plan.src = url;
  el.plan.width = img.naturalWidth;
  el.plan.height = img.naturalHeight;
  el.plan.hidden = false;
  await idbPut('plan', blob).catch(err => console.warn('Plan nicht dauerhaft gespeichert', err));
  saveState();
  fitView();
  recompute();
  renderAll();
  return true;
}

/* ---------- Ansicht (Pan / Zoom) ----------------------------- */

function stageSize() {
  return { w: el.stage.clientWidth, h: el.stage.clientHeight };
}

function fitView(animate) {
  if (!state.plan) return;
  const s = stageSize();
  const pad = 24;
  const z = Math.min((s.w - pad * 2) / state.plan.w, (s.h - pad * 2) / state.plan.h);
  view.fit = z;
  view.z = z;
  view.x = (s.w - state.plan.w * z) / 2;
  view.y = (s.h - state.plan.h * z) / 2;
  applyView(animate);
}

function zoomLimits() {
  return { min: view.fit * 0.5, max: Math.max(view.fit * 12, 3) };
}

function clampView() {
  if (!state.plan) return;
  const s = stageSize();
  const w = state.plan.w * view.z, h = state.plan.h * view.z;
  const marginX = Math.min(s.w * 0.5, w * 0.8);
  const marginY = Math.min(s.h * 0.5, h * 0.8);
  view.x = Math.min(s.w - marginX, Math.max(marginX - w, view.x));
  view.y = Math.min(s.h - marginY, Math.max(marginY - h, view.y));
}

function applyView(animate) {
  clampView();
  el.world.classList.toggle('animate', !!animate);
  el.world.style.transform = `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.z})`;
  el.world.style.setProperty('--iz', String(1 / view.z));
  renderScale();
}

/* Beim ersten Fix nicht auf „ganzer Plan“ stehenbleiben: so weit
   heranzoomen, dass etwa `meters` Meter über die Bildbreite passen. */
function zoomToMeters(meters) {
  if (!state.T) return;
  const s = stageSize();
  const lim = zoomLimits();
  const z = s.w / (meters * state.T.pxPerMeter);
  view.z = Math.min(lim.max, Math.max(view.fit, Math.min(z, lim.max)));
}

function centerOnPlan(px, py, animate) {
  const s = stageSize();
  view.x = s.w / 2 - px * view.z;
  view.y = s.h / 2 - py * view.z;
  applyView(animate);
}

/* Nach Kalibrierung bzw. beim ersten Fix einmal auf eine brauchbare
   Laufweite heranzoomen, danach nur noch mitziehen, wenn „Folgen“ an ist. */
function focusOnMe() {
  if (!state.T || !state.pos) return;
  const q = latLonToPlan(state.T, state.pos.lat, state.pos.lon);
  if (!zoomedOnce) {
    zoomedOnce = true;
    zoomToMeters(150);
    centerOnPlan(q.px, q.py, true);
  } else if (state.follow) {
    centerOnPlan(q.px, q.py, false);
  }
}

function zoomAt(sx, sy, factor) {
  const lim = zoomLimits();
  const nz = Math.min(lim.max, Math.max(lim.min, view.z * factor));
  const f = nz / view.z;
  const r = el.stage.getBoundingClientRect();
  const cx = sx - r.left, cy = sy - r.top;
  view.x = cx - (cx - view.x) * f;
  view.y = cy - (cy - view.y) * f;
  view.z = nz;
  applyView(false);
}

function screenToPlan(sx, sy) {
  const r = el.stage.getBoundingClientRect();
  return { px: (sx - r.left - view.x) / view.z, py: (sy - r.top - view.y) / view.z };
}

/* Gesten */
const pointers = new Map();
let gesture = null;
let longPressTimer = null;

el.stage.addEventListener('pointerdown', ev => {
  el.stage.setPointerCapture(ev.pointerId);
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY, x0: ev.clientX, y0: ev.clientY, t0: Date.now(), moved: false });
  if (pointers.size === 1) {
    gesture = { mode: 'pan' };
    longPressTimer = setTimeout(() => {
      const p = pointers.get(ev.pointerId);
      if (p && !p.moved && !state.mode) {
        longPressTimer = null;
        const at = screenToPlan(p.x, p.y);
        pointers.clear();
        gesture = null;
        el.stage.classList.remove('dragging');
        promptNewMarker(at.px, at.py);
      }
    }, 550);
  } else if (pointers.size === 2) {
    clearTimeout(longPressTimer); longPressTimer = null;
    const [a, b] = [...pointers.values()];
    gesture = {
      mode: 'pinch',
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2
    };
  }
  el.stage.classList.add('dragging');
});

el.stage.addEventListener('pointermove', ev => {
  const p = pointers.get(ev.pointerId);
  if (!p) return;
  const dx = ev.clientX - p.x, dy = ev.clientY - p.y;
  p.x = ev.clientX; p.y = ev.clientY;
  if (Math.hypot(ev.clientX - p.x0, ev.clientY - p.y0) > 9) {
    p.moved = true;
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  }

  if (pointers.size === 1 && gesture && gesture.mode === 'pan') {
    if (!p.moved) return;
    view.x += dx; view.y += dy;
    setFollow(false);
    applyView(false);
  } else if (pointers.size === 2 && gesture && gesture.mode === 'pinch') {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    const r = el.stage.getBoundingClientRect();
    // Verschiebung des Gestenmittelpunkts
    view.x += cx - gesture.cx;
    view.y += cy - gesture.cy;
    gesture.cx = cx; gesture.cy = cy;
    if (gesture.dist > 0 && dist > 0) {
      const lim = zoomLimits();
      const nz = Math.min(lim.max, Math.max(lim.min, view.z * (dist / gesture.dist)));
      const f = nz / view.z;
      const lx = cx - r.left, ly = cy - r.top;
      view.x = lx - (lx - view.x) * f;
      view.y = ly - (ly - view.y) * f;
      view.z = nz;
    }
    gesture.dist = dist;
    setFollow(false);
    applyView(false);
  }
});

function endPointer(ev) {
  const p = pointers.get(ev.pointerId);
  pointers.delete(ev.pointerId);
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  if (pointers.size === 0) {
    el.stage.classList.remove('dragging');
    gesture = null;
    if (p && !p.moved && Date.now() - p.t0 < 400 && ev.type === 'pointerup') {
      handleTap(ev.clientX, ev.clientY);
    }
  } else if (pointers.size === 1) {
    gesture = { mode: 'pan' };
  }
}
el.stage.addEventListener('pointerup', endPointer);
el.stage.addEventListener('pointercancel', endPointer);

el.stage.addEventListener('wheel', ev => {
  ev.preventDefault();
  zoomAt(ev.clientX, ev.clientY, Math.exp(-ev.deltaY * 0.0016));
  setFollow(false);
}, { passive: false });

el.stage.addEventListener('dblclick', ev => {
  zoomAt(ev.clientX, ev.clientY, 1.8);
});

// Safari: Seiten-Zoom per Geste unterdrücken
['gesturestart', 'gesturechange', 'gestureend'].forEach(t =>
  document.addEventListener(t, ev => ev.preventDefault(), { passive: false }));

// Drag & Drop sowie Einfügen eines Planbildes (Desktop-Komfort)
document.addEventListener('dragover', ev => { ev.preventDefault(); });
document.addEventListener('drop', ev => {
  ev.preventDefault();
  const file = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) setPlanFromBlob(file, file.name);
});
document.addEventListener('paste', ev => {
  const items = ev.clipboardData && ev.clipboardData.files;
  if (items && items[0] && items[0].type.startsWith('image/')) setPlanFromBlob(items[0], 'Eingefügter Plan');
});

window.addEventListener('resize', () => {
  if (state.plan) {
    const s = stageSize();
    view.fit = Math.min((s.w - 48) / state.plan.w, (s.h - 48) / state.plan.h);
  }
  applyView(false);
});

function handleTap(sx, sy) {
  if (state.mode) {
    const at = screenToPlan(sx, sy);
    if (!insidePlan(at.px, at.py)) { flashMode('Bitte innerhalb des Plans tippen.'); return; }
    if (state.mode.type === 'calib') finishCalibGps(at.px, at.py);
    else if (state.mode.type === 'calib-manual') finishCalibManual(at.px, at.py);
    else if (state.mode.type === 'marker') { setMode(null); promptNewMarker(at.px, at.py); }
    return;
  }
  // Pointer Capture macht ev.target unbrauchbar – am Bildschirmpunkt nachsehen.
  const hit = document.elementFromPoint(sx, sy);
  const mk = hit && hit.closest ? hit.closest('.mk') : null;
  if (mk) openMarkerActions(mk.dataset.id);
}

function insidePlan(px, py) {
  return !!state.plan && px >= 0 && py >= 0 && px <= state.plan.w && py <= state.plan.h;
}

/* ---------- Kalibrierung ------------------------------------- */

function recompute() {
  if (!state.plan || state.calib.length < 2) { state.T = null; return; }
  const pts = state.calib.map(c => ({
    px: c.u * state.plan.w, py: c.v * state.plan.h, lat: c.lat, lon: c.lon
  }));
  state.T = solveTransform(pts);
}

function addCalibPoint(px, py, lat, lon, acc) {
  state.calib.push({
    id: 'c' + Date.now().toString(36),
    u: px / state.plan.w, v: py / state.plan.h,
    lat, lon, acc: acc == null ? null : Math.round(acc), ts: Date.now()
  });
  saveState();
  recompute();
  renderAll();
  focusOnMe();
  if (state.calib.length === 1) {
    showBanner('Punkt 1 gespeichert. Jetzt einen zweiten Punkt möglichst weit entfernt setzen – dann ist die Karte scharfgestellt.');
  } else {
    const q = calibQuality();
    showBanner(`Kalibriert mit ${state.calib.length} Punkten – ${q.text}.`, q.level === 'bad' ? 'bad' : null, 6000);
  }
}

function startCalibGps() {
  if (!state.plan) { openPlanPicker(); return; }
  if (!state.pos) {
    showBanner('Noch kein GPS-Fix. Kurz ins Freie gehen und warten, bis oben eine Genauigkeit steht.', 'bad');
    return;
  }
  setMode({ type: 'calib' });
}

function finishCalibGps(px, py) {
  if (!state.pos) { flashMode('GPS-Signal verloren.'); return; }
  const { lat, lon, acc } = state.pos;
  setMode(null);
  addCalibPoint(px, py, lat, lon, acc);
}

function startCalibManual() {
  if (!state.plan) { openPlanPicker(); return; }
  setMode({ type: 'calib-manual' });
}

async function finishCalibManual(px, py) {
  setMode(null);
  const res = await openDialog({
    title: 'Koordinaten dieses Punktes',
    text: 'Aus Google Maps / Apple Karten kopiert oder abgetippt. Formate: „45.2938, 13.5897“ oder „45°17\'37.7"N 13°35\'22.9"E“.',
    fields: [{ id: 'coords', label: 'Breite, Länge', placeholder: '45.2938, 13.5897' }]
  });
  if (!res) return;
  const c = parseCoords(res.coords);
  if (!c) { showBanner('Koordinaten nicht erkannt. Beispiel: 45.2938, 13.5897', 'bad'); return; }
  addCalibPoint(px, py, c.lat, c.lon, null);
}

function calibQuality() {
  const T = state.T;
  if (!T) return { level: 'bad', text: 'nicht kalibriert' };
  if (T.n === 2) {
    const d = geoDistance(state.calib[0].lat, state.calib[0].lon, state.calib[1].lat, state.calib[1].lon);
    if (d < 40) return { level: 'warn', text: `Punkte nur ${Math.round(d)} m auseinander – weiter entfernten Punkt ergänzen` };
    return { level: 'good', text: `Basislinie ${fmtDist(d)} · ein dritter Punkt erlaubt eine Kontrolle` };
  }
  const c = T.check;
  if (!c) return { level: 'warn', text: `${T.n} Punkte, keine Kontrolle möglich` };
  if (c.mean <= 5) return { level: 'good', text: `Kontrollfehler Ø ${c.mean.toFixed(1)} m` };
  if (c.mean <= 12) return { level: 'warn', text: `Kontrollfehler Ø ${c.mean.toFixed(1)} m` };
  return { level: 'bad', text: `Kontrollfehler Ø ${c.mean.toFixed(0)} m – Punkte prüfen` };
}

/* ---------- Marker ------------------------------------------- */

const ICONS = ['🏕️', '🚐', '🚗', '⛺', '🚻', '🚿', '🏖️', '🏊', '🍕', '🛒', '🅿️', '🧺', '⭐', '📍'];

async function promptNewMarker(px, py) {
  if (!state.plan) return;
  const res = await openDialog({
    title: 'Marker setzen',
    fields: [{ id: 'name', label: 'Name', placeholder: 'z. B. Stellplatz 214', value: '' }],
    icons: true
  });
  if (!res) return;
  state.markers.push({
    id: 'm' + Date.now().toString(36),
    u: px / state.plan.w, v: py / state.plan.h,
    name: res.name.trim() || 'Marker',
    icon: res.icon || '📍'
  });
  saveState();
  renderMarkers();
  renderSheet();
}

function markerAtMe() {
  if (!state.T || !state.pos) {
    showBanner('Dafür brauche ich Kalibrierung und GPS-Fix. Alternativ die Stelle auf dem Plan antippen.', 'bad');
    return;
  }
  const p = latLonToPlan(state.T, state.pos.lat, state.pos.lon);
  promptNewMarker(p.px, p.py);
}

function markerLatLon(m) {
  if (!state.T) return null;
  return planToLatLon(state.T, m.u * state.plan.w, m.v * state.plan.h);
}

function markerDistance(m) {
  if (!state.pos) return null;
  const c = markerLatLon(m);
  if (!c) return null;
  return geoDistance(state.pos.lat, state.pos.lon, c.lat, c.lon);
}

function openMarkerActions(id) {
  const m = state.markers.find(x => x.id === id);
  if (!m) return;
  const dist = markerDistance(m);
  openActions(`${m.icon} ${m.name}`, [
    {
      label: state.targetId === id ? 'Ziel aufheben' : 'Als Ziel setzen' + (dist != null ? ` (${fmtDist(dist)})` : ''),
      run: () => { state.targetId = state.targetId === id ? null : id; saveState(); renderAll(); }
    },
    {
      label: 'Umbenennen',
      run: async () => {
        const res = await openDialog({
          title: 'Marker bearbeiten',
          fields: [{ id: 'name', label: 'Name', value: m.name }],
          icons: true, icon: m.icon
        });
        if (!res) return;
        m.name = res.name.trim() || m.name;
        m.icon = res.icon || m.icon;
        saveState(); renderMarkers(); renderSheet();
      }
    },
    {
      label: 'Löschen', danger: true,
      run: () => {
        state.markers = state.markers.filter(x => x.id !== id);
        if (state.targetId === id) state.targetId = null;
        saveState(); renderAll();
      }
    }
  ]);
}

/* ---------- GPS ---------------------------------------------- */

let watchId = null;
let zoomedOnce = false;

function startWatch() {
  if (!('geolocation' in navigator)) {
    state.geoError = 'Dieser Browser kann keinen Standort liefern.';
    renderStatus();
    return;
  }
  if (!window.isSecureContext) {
    state.geoError = 'GPS braucht HTTPS. Die Seite über https:// oder localhost öffnen.';
    renderStatus();
    return;
  }
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(onPos, onPosError, {
    enableHighAccuracy: true, maximumAge: 1500, timeout: 30000
  });
}

function onPos(p) {
  const first = !state.pos;
  state.geoError = null;
  state.pos = {
    lat: p.coords.latitude, lon: p.coords.longitude,
    acc: p.coords.accuracy, heading: p.coords.heading,
    speed: p.coords.speed, ts: p.timestamp
  };
  if (!state.opts.compass && typeof p.coords.heading === 'number' && !isNaN(p.coords.heading)
      && p.coords.speed > 0.7) {
    state.heading = p.coords.heading;
  }
  renderMe();
  renderStatus();
  renderTarget();
  renderSheet();
  focusOnMe();
  if (state.mode && state.mode.type === 'calib') renderMode();
}

function onPosError(err) {
  if (err.code === 1) state.geoError = 'Standortfreigabe verweigert. In den Browser-/Seiteneinstellungen erlauben.';
  else if (err.code === 2) state.geoError = 'Kein Standort verfügbar (kein Satellitenempfang?).';
  else state.geoError = 'Standortabfrage dauert zu lange.';
  renderStatus();
}

/* Kompass (optional, braucht auf iOS eine Nutzer-Freigabe) */
let orientBound = false;

async function enableCompass() {
  try {
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') {
      const r = await DOE.requestPermission();
      if (r !== 'granted') throw new Error('abgelehnt');
    }
    if (!orientBound) {
      window.addEventListener('deviceorientationabsolute', onOrient, true);
      window.addEventListener('deviceorientation', onOrient, true);
      orientBound = true;
    }
    state.opts.compass = true;
  } catch (err) {
    state.opts.compass = false;
    showBanner('Kompass nicht verfügbar oder nicht erlaubt.', 'bad');
  }
  saveState();
  renderSheet();
}

function onOrient(ev) {
  let h = null;
  if (typeof ev.webkitCompassHeading === 'number' && !isNaN(ev.webkitCompassHeading)) {
    h = ev.webkitCompassHeading;
  } else if (ev.absolute && typeof ev.alpha === 'number' && !isNaN(ev.alpha)) {
    h = (360 - ev.alpha) % 360;
  }
  if (h == null || !state.opts.compass) return;
  state.heading = h;
  renderMe();
  renderTarget();
}

/* Display anlassen */
let wakeLock = null;
async function setKeepAwake(on) {
  state.opts.keepAwake = on;
  saveState();
  try {
    if (on && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch (err) {
    if (on) showBanner('Display-Sperre lässt sich hier nicht verhindern.', null, 4000);
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.opts.keepAwake && !wakeLock) setKeepAwake(true);
});

/* ---------- Rendern ------------------------------------------ */

function renderAll() {
  renderMe();
  renderMarkers();
  renderCalibPoints();
  renderStatus();
  renderTarget();
  renderScale();
  renderSheet();
  el.btnFollow.classList.toggle('active', state.follow);
}

function renderMe() {
  if (!state.T || !state.pos || !state.plan) {
    el.me.hidden = true; el.acc.hidden = true;
    return;
  }
  const p = latLonToPlan(state.T, state.pos.lat, state.pos.lon);
  el.me.hidden = false;
  el.me.style.left = p.px + 'px';
  el.me.style.top = p.py + 'px';

  const r = (state.pos.acc || 0) * state.T.pxPerMeter;
  if (r > 2) {
    el.acc.hidden = false;
    el.acc.style.left = p.px + 'px';
    el.acc.style.top = p.py + 'px';
    el.acc.style.width = (r * 2) + 'px';
    el.acc.style.height = (r * 2) + 'px';
  } else {
    el.acc.hidden = true;
  }

  if (state.heading != null) {
    el.meArrow.hidden = false;
    el.meArrow.style.setProperty('--rot', ((state.heading + state.T.northDeg) % 360) + 'deg');
  } else {
    el.meArrow.hidden = true;
  }
}

function renderMarkers() {
  if (!state.plan) { el.markers.innerHTML = ''; return; }
  el.markers.innerHTML = '';
  el.markers.style.pointerEvents = state.mode ? 'none' : 'auto';
  for (const m of state.markers) {
    const d = document.createElement('div');
    d.className = 'mk' + (state.targetId === m.id ? ' is-target' : '');
    d.dataset.id = m.id;
    d.style.left = (m.u * state.plan.w) + 'px';
    d.style.top = (m.v * state.plan.h) + 'px';
    d.innerHTML = `<div class="pin"><div class="cap"></div><div class="bubble"><span></span></div></div>`;
    d.querySelector('.cap').textContent = m.name;
    d.querySelector('.bubble > span').textContent = m.icon;
    el.markers.appendChild(d);
  }
}

function renderCalibPoints() {
  if (!state.plan) { el.calibpts.innerHTML = ''; return; }
  el.calibpts.innerHTML = '';
  state.calib.forEach((c, i) => {
    const d = document.createElement('div');
    d.className = 'cp';
    d.style.left = (c.u * state.plan.w) + 'px';
    d.style.top = (c.v * state.plan.h) + 'px';
    d.innerHTML = `<div class="x">${i + 1}</div>`;
    el.calibpts.appendChild(d);
  });
}

function renderStatus() {
  let level = 'bad', txt;
  if (!state.plan) {
    txt = 'Kein Lageplan geladen';
  } else if (state.geoError) {
    txt = state.geoError;
  } else if (!state.pos) {
    txt = 'Suche GPS …';
    level = 'warn';
  } else {
    const acc = Math.round(state.pos.acc || 0);
    level = acc <= 15 ? 'good' : acc <= 40 ? 'warn' : 'bad';
    txt = `GPS ±${acc} m`;
    if (!state.T) { txt += ' · nicht kalibriert'; level = 'warn'; }
    else {
      const p = latLonToPlan(state.T, state.pos.lat, state.pos.lon);
      if (!insidePlan(p.px, p.py)) txt += ' · außerhalb des Plans';
    }
  }
  el.status.className = 'chip status ' + level;
  el.status.innerHTML = '<span class="dot"></span><span class="txt"></span>';
  el.status.querySelector('.txt').textContent = txt;

  el.compass.hidden = !state.T;
  if (state.T) el.compass.style.setProperty('--north', state.T.northDeg + 'deg');

  el.btnCalib.classList.toggle('active', !!state.mode);
  el.btnFollow.classList.toggle('active', state.follow && !!state.T);
}

function renderScale() {
  if (!state.T) { el.scalebar.hidden = true; return; }
  const mPerPx = 1 / (state.T.pxPerMeter * view.z);
  const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  let pick = nice[0];
  for (const n of nice) { if (n / mPerPx <= 130) pick = n; }
  const w = pick / mPerPx;
  if (!isFinite(w) || w < 20) { el.scalebar.hidden = true; return; }
  el.scalebar.hidden = false;
  el.scalebar.classList.toggle('shifted', !el.targetbar.hidden);
  el.scalebar.querySelector('.bar').style.width = w + 'px';
  el.scaletext.textContent = pick >= 1000 ? (pick / 1000) + ' km' : pick + ' m';
}

function renderTarget() {
  const m = state.markers.find(x => x.id === state.targetId);
  if (!m || !state.T) {
    el.targetbar.hidden = true;
    el.scalebar.classList.remove('shifted');
    return;
  }
  const c = markerLatLon(m);
  el.targetbar.hidden = false;
  el.scalebar.classList.add('shifted');
  el.targetName.textContent = `${m.icon} ${m.name}`;
  if (!state.pos) {
    el.targetDist.textContent = 'Warte auf GPS …';
    el.targetArrow.style.setProperty('--rot', '0deg');
    return;
  }
  const dist = geoDistance(state.pos.lat, state.pos.lon, c.lat, c.lon);
  const brg = bearingDeg(state.pos.lat, state.pos.lon, c.lat, c.lon);
  let rot, hint;
  if (state.opts.compass && state.heading != null) {
    rot = (brg - state.heading + 360) % 360;
    hint = 'vor dir';
  } else {
    rot = (brg + state.T.northDeg) % 360;
    hint = 'in Kartenrichtung';
  }
  el.targetArrow.style.setProperty('--rot', rot + 'deg');
  el.targetDist.textContent = `${fmtDist(dist)} · ${compassName(brg)} · ${hint}`;
  el.scalebar.classList.add('shifted');
}

function fmtDist(m) {
  if (m == null) return '–';
  if (m < 20) return Math.round(m) + ' m';
  if (m < 950) return Math.round(m / 5) * 5 + ' m';
  return (m / 1000).toFixed(m < 9500 ? 1 : 0) + ' km';
}

let bannerTimer = null;
function showBanner(text, level, ms) {
  el.banner.textContent = text;
  el.banner.className = level === 'bad' ? 'bad' : '';
  el.banner.hidden = false;
  if (bannerTimer) clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { el.banner.hidden = true; }, ms || 7000);
}

function setMode(mode) {
  state.mode = mode;
  el.banner.hidden = true;
  renderMode();
  renderMarkers();
  renderStatus();
}

function renderMode() {
  if (!state.mode) { el.modebar.hidden = true; return; }
  el.modebar.hidden = false;
  if (state.mode.type === 'calib') {
    const acc = state.pos ? `GPS ±${Math.round(state.pos.acc)} m` : 'kein GPS';
    el.modetext.textContent = `Tippe genau die Stelle auf dem Plan an, an der du jetzt stehst (${acc}).`;
  } else if (state.mode.type === 'calib-manual') {
    el.modetext.textContent = 'Tippe die Stelle an, deren Koordinaten du kennst.';
  } else if (state.mode.type === 'marker') {
    el.modetext.textContent = 'Tippe die Stelle an, die du markieren willst.';
  }
}

function flashMode(msg) { showBanner(msg, 'bad', 3500); }

function setFollow(on) {
  if (state.follow === on) return;
  state.follow = on;
  el.btnFollow.classList.toggle('active', on);
}

/* ---------- Sheet / Dialoge ---------------------------------- */

function openOverlay(node) { node.hidden = false; }
function closeOverlay(node) { node.hidden = true; }

function renderSheet() {
  if (el.sheet.hidden) return;
  $('#plan-info').textContent = state.plan
    ? `${state.plan.name} · ${state.plan.w} × ${state.plan.h} px`
    : 'Kein Plan geladen.';

  const q = calibQuality();
  const st = $('#calib-status');
  st.innerHTML = '';
  const tag = document.createElement('span');
  tag.className = 'tag ' + q.level;
  tag.textContent = state.T ? (state.T.n >= 3 && !state.T.fellBack ? 'affin' : 'Drehung + Maßstab') : 'offen';
  const wrap = document.createElement('span');
  wrap.className = 'quality';
  wrap.append(tag, document.createTextNode(q.text));
  st.appendChild(wrap);
  if (state.T) {
    const extra = document.createElement('div');
    extra.className = 'muted small';
    extra.textContent = `Maßstab: 1 px ≈ ${(1 / state.T.pxPerMeter).toFixed(2)} m · Nord zeigt ${Math.round(state.T.northDeg)}° im Plan`
      + (state.T.fellBack ? ' · Punkte widersprüchlich, nutze Drehung + Maßstab' : '');
    st.appendChild(extra);
  }

  const list = $('#calib-list');
  list.innerHTML = '';
  state.calib.forEach((c, i) => {
    const li = document.createElement('li');
    const chk = state.T && state.T.checkErrors ? state.T.checkErrors[i] : null;
    li.innerHTML = `<span class="ic">${i + 1}</span><div class="txt"><b></b><span></span></div>`;
    li.querySelector('b').textContent = `${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}`;
    li.querySelector('.txt span').textContent =
      (c.acc != null ? `GPS ±${c.acc} m` : 'manuell eingegeben')
      + (chk != null ? ` · Kontrolle ${chk.toFixed(1)} m` : '');
    const del = document.createElement('button');
    del.className = 'btn ghost small danger';
    del.textContent = 'Löschen';
    del.onclick = () => {
      state.calib = state.calib.filter(x => x.id !== c.id);
      saveState(); recompute(); renderAll();
    };
    li.appendChild(del);
    list.appendChild(li);
  });

  const ml = $('#marker-list');
  ml.innerHTML = '';
  $('#marker-empty').hidden = state.markers.length > 0;
  for (const m of state.markers) {
    const li = document.createElement('li');
    const d = markerDistance(m);
    li.innerHTML = `<span class="ic"></span><div class="txt"><b></b><span></span></div>`;
    li.querySelector('.ic').textContent = m.icon;
    li.querySelector('b').textContent = m.name;
    li.querySelector('.txt span').textContent = d != null ? fmtDist(d) + ' entfernt' : '';
    const go = document.createElement('button');
    go.className = 'btn ghost small';
    go.textContent = 'Zeigen';
    go.onclick = () => {
      closeOverlay(el.sheet);
      setFollow(false);
      centerOnPlan(m.u * state.plan.w, m.v * state.plan.h, true);
      state.targetId = m.id; saveState(); renderAll();
    };
    li.appendChild(go);
    ml.appendChild(li);
  }

  $('#opt-compass').checked = !!state.opts.compass;
  $('#opt-keepawake').checked = !!state.opts.keepAwake;
  $('#version').textContent = `Version ${APP_VERSION}`;
}

function openDialog({ title, text, fields = [], icons = false, icon = '📍', okLabel = 'Speichern' }) {
  return new Promise(resolve => {
    $('#dlg-title').textContent = title;
    $('#dlg-text').textContent = text || '';
    $('#dlg-text').hidden = !text;
    $('#dlg-ok').textContent = okLabel;
    const body = $('#dlg-body');
    body.innerHTML = '';
    let chosen = icon;

    const inputs = fields.map(f => {
      const lab = document.createElement('label');
      lab.className = 'muted small';
      lab.textContent = f.label || '';
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.placeholder = f.placeholder || '';
      inp.value = f.value || '';
      inp.autocomplete = 'off';
      body.append(lab, inp);
      return { id: f.id, inp };
    });

    if (icons) {
      const grid = document.createElement('div');
      grid.className = 'emoji-grid';
      ICONS.forEach(ic => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = ic;
        if (ic === chosen) b.classList.add('sel');
        b.onclick = () => {
          chosen = ic;
          [...grid.children].forEach(c => c.classList.toggle('sel', c === b));
        };
        grid.appendChild(b);
      });
      body.appendChild(grid);
    }

    openOverlay(el.dialog);
    if (inputs[0]) setTimeout(() => inputs[0].inp.focus(), 60);

    const done = val => {
      $('#dlg-ok').onclick = null;
      $('#dlg-cancel').onclick = null;
      closeOverlay(el.dialog);
      resolve(val);
    };
    $('#dlg-ok').onclick = () => {
      const out = { icon: chosen };
      inputs.forEach(i => { out[i.id] = i.inp.value; });
      done(out);
    };
    $('#dlg-cancel').onclick = () => done(null);
    if (inputs[0]) inputs[0].inp.onkeydown = ev => { if (ev.key === 'Enter') $('#dlg-ok').click(); };
  });
}

function openActions(title, items) {
  $('#actions-title').textContent = title;
  const body = $('#actions-body');
  body.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'btn block' + (it.danger ? ' danger' : '');
    b.textContent = it.label;
    b.onclick = () => { closeOverlay(el.actions); it.run(); };
    body.appendChild(b);
  }
  openOverlay(el.actions);
}

/* ---------- Import / Export ---------------------------------- */

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

function dataURLToBlob(url) {
  const [head, b64] = String(url).split(',');
  const mime = (head.match(/data:([^;]+)/) || [, 'application/octet-stream'])[1];
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: mime });
}

async function exportData() {
  const out = {
    app: 'campmap', version: 1, exported: new Date().toISOString(),
    plan: state.plan ? { name: state.plan.name, w: state.plan.w, h: state.plan.h } : null,
    calib: state.calib, markers: state.markers
  };
  try {
    const blob = out.plan ? await idbGet('plan') : null;
    if (blob) out.plan.image = await blobToDataURL(blob);
  } catch (err) { console.warn('Planbild nicht im Export', err); }

  const file = new Blob([JSON.stringify(out)], { type: 'application/json' });
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'platzkarte.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function importData(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (err) {
    showBanner('Datei ist kein gültiger Export.', 'bad');
    return;
  }
  if (!data || data.app !== 'campmap') { showBanner('Datei ist kein Platzkarte-Export.', 'bad'); return; }
  state.calib = Array.isArray(data.calib) ? data.calib : [];
  state.markers = Array.isArray(data.markers) ? data.markers : [];
  state.targetId = null;
  if (data.plan && data.plan.image) {
    await setPlanFromBlob(dataURLToBlob(data.plan.image), data.plan.name || 'Importierter Plan');
  } else if (state.plan) {
    saveState(); recompute(); renderAll();
  }
  closeOverlay(el.sheet);
  closeOverlay(el.welcome);
  showBanner('Karte importiert.', null, 4000);
}

/* ---------- Verdrahtung -------------------------------------- */

function openPlanPicker() { el.filePlan.click(); }

el.filePlan.addEventListener('change', async ev => {
  const f = ev.target.files && ev.target.files[0];
  el.filePlan.value = '';
  if (!f) return;
  const replacing = !!state.plan;
  const ok = await setPlanFromBlob(f, f.name);
  if (!ok) return;
  closeOverlay(el.welcome);
  closeOverlay(el.sheet);
  if (replacing && state.calib.length) {
    showBanner('Plan ersetzt. Kalibrierung wurde übernommen – bitte prüfen, ob die Punkte noch passen (gleicher Bildausschnitt?).', null, 9000);
  } else if (!state.calib.length) {
    showBanner('Plan geladen. Jetzt kalibrieren: „Kalibrieren“ antippen, während du an einer erkennbaren Stelle stehst.', null, 9000);
  }
});

el.fileImport.addEventListener('change', ev => {
  const f = ev.target.files && ev.target.files[0];
  el.fileImport.value = '';
  if (f) importData(f);
});

$('#welcome-load').onclick = openPlanPicker;
$('#welcome-import').onclick = () => el.fileImport.click();
$('#btn-menu').onclick = () => { openOverlay(el.sheet); renderSheet(); };
$('#sheet-close').onclick = () => closeOverlay(el.sheet);
$('#plan-replace').onclick = openPlanPicker;
$('#plan-fit').onclick = () => { closeOverlay(el.sheet); setFollow(false); fitView(true); };
$('#calib-gps').onclick = () => { closeOverlay(el.sheet); startCalibGps(); };
$('#calib-manual').onclick = () => { closeOverlay(el.sheet); startCalibManual(); };
$('#calib-clear').onclick = () => {
  if (!state.calib.length) return;
  openActions('Kalibrierung löschen?', [{
    label: 'Ja, alle Punkte löschen', danger: true,
    run: () => { state.calib = []; saveState(); recompute(); renderAll(); }
  }]);
};
$('#data-export').onclick = exportData;
$('#data-import').onclick = () => el.fileImport.click();
$('#opt-compass').onchange = ev => {
  if (ev.target.checked) enableCompass();
  else { state.opts.compass = false; state.heading = null; saveState(); renderMe(); renderTarget(); }
};
$('#opt-keepawake').onchange = ev => setKeepAwake(ev.target.checked);
$('#target-clear').onclick = () => { state.targetId = null; saveState(); renderAll(); };
$('#mode-cancel').onclick = () => setMode(null);
$('#dialog').addEventListener('click', ev => { if (ev.target === el.dialog) $('#dlg-cancel').click(); });
$('#actions-close').onclick = () => closeOverlay(el.actions);
$('#actions').addEventListener('click', ev => { if (ev.target === el.actions) closeOverlay(el.actions); });
$('#sheet').addEventListener('click', ev => { if (ev.target === el.sheet) closeOverlay(el.sheet); });

el.btnFollow.onclick = () => {
  if (!state.T) { showBanner('Erst kalibrieren, dann kann die Karte dir folgen.', 'bad'); return; }
  setFollow(!state.follow);
  if (state.follow && state.pos) {
    const q = latLonToPlan(state.T, state.pos.lat, state.pos.lon);
    centerOnPlan(q.px, q.py, true);
  }
};

el.btnMarker.onclick = () => {
  if (!state.plan) { openPlanPicker(); return; }
  openActions('Marker setzen', [
    { label: '📍 Hier, wo ich stehe', run: markerAtMe },
    { label: '👆 Stelle auf dem Plan antippen', run: () => setMode({ type: 'marker' }) }
  ]);
};

el.btnCalib.onclick = () => {
  if (state.mode) { setMode(null); return; }
  if (!state.plan) { openPlanPicker(); return; }
  if (state.calib.length >= 2) {
    openActions('Kalibrierung', [
      { label: '⊕ Weiteren Punkt setzen (genauer)', run: startCalibGps },
      { label: '⌨︎ Punkt über Koordinaten', run: startCalibManual },
      { label: 'Punkte verwalten', run: () => { openOverlay(el.sheet); renderSheet(); } }
    ]);
  } else {
    startCalibGps();
  }
};

/* ---------- Start -------------------------------------------- */

async function boot() {
  loadState();
  let blob = null;
  try { blob = await idbGet('plan'); } catch (err) { console.warn(err); }
  if (blob) {
    await setPlanFromBlob(blob, state.plan ? state.plan.name : 'Lageplan');
  } else {
    state.plan = null;
    openOverlay(el.welcome);
  }
  recompute();
  renderAll();
  if (state.opts.compass) enableCompass();
  if (state.opts.keepAwake) setKeepAwake(true);
  startWatch();
  if (state.plan && state.calib.length < 2) {
    showBanner('Noch nicht kalibriert: „Kalibrieren“ antippen, wenn du an einer auf dem Plan erkennbaren Stelle stehst.', null, 12000);
  }

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service Worker aus', err));
  }
}

window.__app = { state, view, recompute, renderAll, setPlanFromBlob, addCalibPoint, fitView, latLonToPlan };

boot();
