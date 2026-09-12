/* End-to-End-Test mit echtem Browser und gemocktem GPS.
   Voraussetzung: statischer Server auf dem Ordner camping-map, z. B.
     python3 -m http.server 8765 --directory camping-map
   Aufruf:
     npm i playwright && node camping-map/test/browser.test.mjs
   Optional: PORT, BASE_URL, SHOTS (Screenshot-Ordner),
   CHROMIUM_PATH (falls ein vorhandener Chromium genutzt werden soll). */
import { chromium } from 'playwright';
import fs from 'node:fs';
import assert from 'node:assert/strict';

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL || `http://localhost:${process.env.PORT || 8765}`;
const OUT = process.env.SHOTS || path.join(os.tmpdir(), 'campmap-shots');
fs.mkdirSync(OUT, { recursive: true });

// --- Wahrheit für den Demo-Plan (1200x800): 2 px/m, Nord 20°, Ursprung Bildmitte
const REF = { lat: 45.2938, lon: 13.5897 };
const PXPM = 2.0, ROT = 20 * Math.PI / 180, OX = 600, OY = 400;
const M_LAT = 111132.95, M_LON = 111319.49;

const project = (lat, lon) => ({
  x: (lon - REF.lon) * M_LON * Math.cos(REF.lat * Math.PI / 180),
  y: -(lat - REF.lat) * M_LAT
});
const unproject = (x, y) => ({
  lat: REF.lat - y / M_LAT,
  lon: REF.lon + x / (M_LON * Math.cos(REF.lat * Math.PI / 180))
});
const toPx = (lat, lon) => {
  const m = project(lat, lon);
  return {
    px: PXPM * (Math.cos(ROT) * m.x - Math.sin(ROT) * m.y) + OX,
    py: PXPM * (Math.sin(ROT) * m.x + Math.cos(ROT) * m.y) + OY
  };
};
const toLatLon = (px, py) => {
  const dx = (px - OX) / PXPM, dy = (py - OY) / PXPM;
  const x = Math.cos(ROT) * dx + Math.sin(ROT) * dy;
  const y = -Math.sin(ROT) * dx + Math.cos(ROT) * dy;
  return unproject(x, y);
};

const CAL_A = toLatLon(180, 180);     // Rezeption-Ecke
const CAL_B = toLatLon(1020, 690);    // Strandseite
const ME = toLatLon(700, 430);        // aktuelle Position

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox']
});
const ctx = await browser.newContext({
  viewport: { width: 412, height: 892 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  permissions: ['geolocation'],
  geolocation: { latitude: ME.lat, longitude: ME.lon, accuracy: 8 },
  locale: 'de-DE'
});
const page = await ctx.newPage();
const errors = [];
// 404-Meldungen beim Durchprobieren der Standardplan-Quellen sind erwartet
const expectedNoise = /404|Failed to load resource/i;
page.on('console', m => {
  if (m.type() === 'error' && !expectedNoise.test(m.text())) errors.push(m.text());
});
page.on('pageerror', e => errors.push('pageerror: ' + e.message));

await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });

// 1) Startbereit: entweder Onboarding (kein Standardplan hinterlegt) oder
//    der Standardplan aus plan/ ist schon geladen.
await page.waitForFunction(
  () => window.__app && (window.__app.state.plan !== null ||
        !document.querySelector('#welcome').hidden),
  null, { timeout: 20000 }
);
const started = await page.evaluate(() => ({
  plan: window.__app.state.plan,
  welcome: !document.querySelector('#welcome').hidden
}));
assert.ok(started.plan || started.welcome, 'App ist startbereit');
await page.screenshot({ path: `${OUT}/01-start.png` });

// 2) Plan laden (wie über den Dateidialog, nur ohne Dateidialog)
await page.locator('#file-plan').setInputFiles(path.join(here, 'demo-plan.png'));
// Auf genau diesen Plan warten – ein hinterlegter Standardplan wäre sonst schneller
await page.waitForFunction(
  () => window.__app.state.plan && window.__app.state.plan.w === 1200,
  null, { timeout: 15000 }
);
await page.waitForTimeout(400);
assert.equal(await page.locator('#welcome').isVisible(), false, 'Onboarding schließt sich');
const planSize = await page.evaluate(() => window.__app.state.plan);
assert.deepEqual([planSize.w, planSize.h], [1200, 800]);
await page.screenshot({ path: `${OUT}/02-plan.png` });

// Status muss "nicht kalibriert" melden, sobald GPS da ist
await page.waitForFunction(() => window.__app.state.pos !== null, null, { timeout: 15000 });
const status1 = await page.locator('#status .txt').textContent();
assert.match(status1, /nicht kalibriert/, `Status: ${status1}`);

// 3) Zwei Kalibrierpunkte setzen
await page.evaluate(([a, b]) => {
  window.__app.addCalibPoint(180, 180, a.lat, a.lon, 6);
  window.__app.addCalibPoint(1020, 690, b.lat, b.lon, 7);
}, [CAL_A, CAL_B]);
await page.waitForTimeout(300);

const T = await page.evaluate(() => {
  const t = window.__app.state.T;
  return { n: t.n, pxPerMeter: t.pxPerMeter, northDeg: t.northDeg, rms: t.rms };
});
assert.ok(Math.abs(T.pxPerMeter - PXPM) < 0.01, `Maßstab ${T.pxPerMeter}`);
assert.ok(Math.abs(T.northDeg - 20) < 0.3, `Nord ${T.northDeg}`);

// 4) Position muss auf dem Plan an der erwarteten Stelle liegen
await page.waitForFunction(() => !document.querySelector('#me').hidden, null, { timeout: 10000 });
const mePos = await page.evaluate(() => ({
  left: parseFloat(document.querySelector('#me').style.left),
  top: parseFloat(document.querySelector('#me').style.top)
}));
const errPx = Math.hypot(mePos.left - 700, mePos.top - 430);
assert.ok(errPx < 1.5, `Positionsmarker ${errPx.toFixed(2)} px daneben`);

// Karte muss nach dem Kalibrieren herangezoomt sein, nicht auf Gesamtansicht stehen
const zoomInfo = await page.evaluate(() => ({
  z: window.__app.view.z, fit: window.__app.view.fit,
  metersAcross: document.querySelector('#stage').clientWidth /
                (window.__app.view.z * window.__app.state.T.pxPerMeter)
}));
assert.ok(zoomInfo.z > zoomInfo.fit * 2, `Zoom ${zoomInfo.z} vs. fit ${zoomInfo.fit}`);
assert.ok(zoomInfo.metersAcross > 80 && zoomInfo.metersAcross < 250,
  `Bildbreite ${zoomInfo.metersAcross.toFixed(0)} m`);

const status2 = await page.locator('#status .txt').textContent();
assert.match(status2, /GPS ±8 m/, `Status: ${status2}`);
assert.equal(await page.locator('#compass').isVisible(), true, 'Kompass erscheint nach Kalibrierung');
assert.equal(await page.locator('#scalebar').isVisible(), true, 'Maßstabsleiste erscheint');
await page.screenshot({ path: `${OUT}/03-located.png` });

// 5) Marker an der eigenen Position anlegen (kompletter UI-Weg)
await page.locator('#btn-marker').click();
await page.getByText('Hier, wo ich stehe').click();
await page.locator('#dlg-body input').fill('Stellplatz 214');
await page.locator('.emoji-grid button', { hasText: '🚐' }).click();
await page.locator('#dlg-ok').click();
await page.waitForTimeout(200);
assert.equal(await page.locator('.mk').count(), 1, 'Marker sichtbar');
assert.match(await page.locator('.mk .cap').textContent(), /Stellplatz 214/);

// 6) Zweiten Marker per Plan-Tap setzen und als Ziel wählen
await page.locator('#btn-marker').click();
await page.getByText('Stelle auf dem Plan antippen').click();
assert.equal(await page.locator('#modebar').isVisible(), true, 'Modusleiste erklärt den nächsten Schritt');
// Bildschirmpunkt nahe der Mitte wählen und prüfen, dass er auf dem Plan liegt
const stageBox = await page.locator('#stage').boundingBox();
const clickAt = { x: stageBox.x + stageBox.width / 2, y: stageBox.y + stageBox.height / 2 - 90 };
const onPlan = await page.evaluate(([sx, sy]) => {
  const v = window.__app.view, p = window.__app.state.plan;
  const r = document.querySelector('#stage').getBoundingClientRect();
  const px = (sx - r.left - v.x) / v.z, py = (sy - r.top - v.y) / v.z;
  return px >= 0 && py >= 0 && px <= p.w && py <= p.h;
}, [clickAt.x, clickAt.y]);
assert.equal(onPlan, true, 'Testklick liegt auf dem Plan');
await page.mouse.click(clickAt.x, clickAt.y);
await page.locator('#dlg-body input').fill('Strandbar');
await page.locator('.emoji-grid button', { hasText: '🏖️' }).click();
await page.locator('#dlg-ok').click();
await page.waitForTimeout(200);
assert.equal(await page.locator('.mk').count(), 2);

await page.locator('.mk', { hasText: 'Strandbar' }).click();
await page.getByText('Als Ziel setzen').click();
await page.waitForTimeout(200);
assert.equal(await page.locator('#targetbar').isVisible(), true, 'Zielleiste sichtbar');
const dist = await page.locator('#target-dist').textContent();
assert.match(dist, /\d+\s*m|km/, `Distanzangabe: ${dist}`);
await page.screenshot({ path: `${OUT}/04-target.png` });

// 7) Bewegung: neue Position -> Marker wandert mit
const ME2 = toLatLon(500, 300);
await ctx.setGeolocation({ latitude: ME2.lat, longitude: ME2.lon, accuracy: 12 });
await page.waitForFunction(
  () => Math.abs(parseFloat(document.querySelector('#me').style.left) - 500) < 2,
  null, { timeout: 15000 }
);
const me2 = await page.evaluate(() => ({
  left: parseFloat(document.querySelector('#me').style.left),
  top: parseFloat(document.querySelector('#me').style.top)
}));
assert.ok(Math.hypot(me2.left - 500, me2.top - 300) < 2, `nach Bewegung ${JSON.stringify(me2)}`);

// 8) Menü / Kalibrier-Übersicht
await page.locator('#btn-menu').click();
await page.waitForTimeout(200);
const calibStatus = await page.locator('#calib-status').textContent();
assert.match(calibStatus, /Basislinie/, `Kalibrier-Status: ${calibStatus}`);
await page.screenshot({ path: `${OUT}/05-sheet.png` });
await page.locator('#sheet-close').click();

// 9) Neuladen: alles muss zurückkommen (IndexedDB + localStorage)
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__app && window.__app.state.plan !== null, null, { timeout: 10000 });
await page.waitForTimeout(600);
assert.equal(await page.locator('.mk').count(), 2, 'Marker überleben Neustart');
const restored = await page.evaluate(() => ({
  calib: window.__app.state.calib.length,
  hasT: !!window.__app.state.T,
  planW: window.__app.state.plan.w
}));
assert.deepEqual(restored, { calib: 2, hasT: true, planW: 1200 });

// 10) Zoom-Geste per Rad, dann Maßstab prüfen
const before = await page.evaluate(() => window.__app.view.z);
await page.mouse.move(200, 400);
await page.mouse.wheel(0, -400);
await page.waitForTimeout(200);
const after = await page.evaluate(() => window.__app.view.z);
assert.ok(after > before, `Zoom ${before} -> ${after}`);
await page.screenshot({ path: `${OUT}/06-zoom.png` });

// 11) PDF als Plan: wird im Browser gerendert (pdf.js aus vendor/)
const pdfPage = await ctx.newPage();
const pdfErrors = [];
pdfPage.on('pageerror', e => pdfErrors.push('pageerror: ' + e.message));
await pdfPage.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
await pdfPage.evaluate(() => indexedDB.deleteDatabase('campmap') && localStorage.clear());
await pdfPage.reload({ waitUntil: 'networkidle' });
await pdfPage.locator('#file-plan').setInputFiles(path.join(here, 'demo-plan.pdf'));
await pdfPage.waitForFunction(
  () => window.__app && window.__app.state.plan &&
        /^demo-plan/.test(window.__app.state.plan.name),
  null, { timeout: 40000 }
);
const pdfPlan = await pdfPage.evaluate(() => window.__app.state.plan);
assert.ok(pdfPlan.w >= 2300, `PDF in hoher Auflösung gerendert: ${pdfPlan.w} px`);
assert.ok(Math.abs(pdfPlan.w / pdfPlan.h - 1200 / 800) < 0.05, 'Seitenverhältnis bleibt erhalten');
await pdfPage.screenshot({ path: `${OUT}/07-pdf.png` });
assert.deepEqual(pdfErrors, [], 'keine Fehler beim PDF-Import:\n' + pdfErrors.join('\n'));
await pdfPage.close();

// 12) Standardplan wird beim ersten Start automatisch geladen
const planDir = path.join(here, '..', 'plan');
const planFile = path.join(planDir, 'camping-solaris-map.webp');
const planExisted = fs.existsSync(planFile);
if (!planExisted) {
  fs.mkdirSync(planDir, { recursive: true });
  fs.copyFileSync(path.join(here, 'demo-plan.png'), planFile);   // Inhalt egal, Bild reicht
}
try {
  const autoPage = await ctx.newPage();
  await autoPage.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
  await autoPage.evaluate(() => indexedDB.deleteDatabase('campmap') && localStorage.clear());
  await autoPage.reload({ waitUntil: 'networkidle' });
  await autoPage.waitForFunction(
    () => window.__app && window.__app.state.plan !== null, null, { timeout: 20000 }
  );
  assert.equal(await autoPage.locator('#welcome').isVisible(), false,
    'kein Onboarding nötig, wenn ein Standardplan hinterlegt ist');
  await autoPage.close();
} finally {
  if (!planExisted) {
    fs.rmSync(planFile, { force: true });
    if (fs.readdirSync(planDir).length === 0) fs.rmdirSync(planDir);
  }
}

assert.deepEqual(errors, [], 'keine Konsolenfehler:\n' + errors.join('\n'));

await browser.close();
console.log('BROWSER-TESTS OK');
