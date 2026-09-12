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

/* 13) Der Fall aus der Praxis: iOS lässt watchPosition nach dem Sperren des
   Displays einschlafen. Wer dann am anderen Ende des Platzes kalibriert,
   darf NICHT die alte Position gespeichert bekommen. */
const stale = await ctx.newPage();
await stale.addInitScript(() => {
  // Watch liefert genau einen Fix und schweigt danach – wie auf dem iPhone
  const realWatch = navigator.geolocation.watchPosition.bind(navigator.geolocation);
  let delivered = 0;
  navigator.geolocation.watchPosition = (ok, err, opts) =>
    realWatch(p => { if (delivered++ === 0) ok(p); }, err, opts);
});
const staleErrors = [];
stale.on('pageerror', e => staleErrors.push('pageerror: ' + e.message));

const POS_A = toLatLon(200, 200);     // erster Standort
const POS_B = toLatLon(1000, 700);    // anderes Ende des Platzes
await ctx.setGeolocation({ latitude: POS_A.lat, longitude: POS_A.lon, accuracy: 6 });
await stale.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
await stale.evaluate(() => { indexedDB.deleteDatabase('campmap'); localStorage.clear(); });
await stale.reload({ waitUntil: 'networkidle' });
await stale.locator('#file-plan').setInputFiles(path.join(here, 'demo-plan.png'));
await stale.waitForFunction(
  () => window.__app.state.plan && window.__app.state.plan.w === 1200, null, { timeout: 15000 });
await stale.waitForFunction(() => window.__app.state.pos !== null, null, { timeout: 15000 });

// Nutzer läuft ans andere Ende; der eingeschlafene Watch merkt davon nichts
await ctx.setGeolocation({ latitude: POS_B.lat, longitude: POS_B.lon, accuracy: 6 });
await stale.evaluate(() => { window.__app.state.pos.rx -= 300000; });   // Fix ist 5 min alt
// Die Statuszeile frischt sich selbst auf und muss das Alter melden
await stale.waitForFunction(
  () => /alt/.test(document.querySelector('#status .txt').textContent),
  null, { timeout: 12000 }
);

await stale.locator('#btn-calib').click();
await stale.waitForTimeout(200);
const box2 = await stale.locator('#stage').boundingBox();
await stale.mouse.click(box2.x + box2.width / 2, box2.y + box2.height / 2);
await stale.waitForFunction(() => window.__app.state.calib.length === 1, null, { timeout: 25000 });
const saved = await stale.evaluate(() => window.__app.state.calib[0]);
const dToB = Math.hypot(saved.lat - POS_B.lat, saved.lon - POS_B.lon);
const dToA = Math.hypot(saved.lat - POS_A.lat, saved.lon - POS_A.lon);
assert.ok(dToB < dToA, 'gespeichert wird der frische Standort, nicht der eingefrorene');
assert.ok(Math.abs(saved.lat - POS_B.lat) < 1e-5, `Breite ${saved.lat} statt ${POS_B.lat}`);

// 14) Zweiter Punkt mit unveränderter Position, aber weit weg getippt -> Nachfrage
await stale.locator('#btn-calib').click();
await stale.waitForTimeout(200);
// Weit entfernte Stelle *auf dem Plan* treffen, nicht daneben
const farPoint = await stale.evaluate(() => {
  const v = window.__app.view;
  const r = document.querySelector('#stage').getBoundingClientRect();
  return { x: r.left + v.x + 1050 * v.z, y: r.top + v.y + 700 * v.z };
});
await stale.mouse.click(farPoint.x, farPoint.y);
await stale.waitForSelector('#actions:not([hidden])', { timeout: 25000 });
assert.match(await stale.locator('#actions-title').textContent(), /bewegt sich nicht/,
  'App warnt statt den unbrauchbaren Punkt zu schlucken');
assert.equal(await stale.evaluate(() => window.__app.state.calib.length), 1,
  'Punkt wurde nicht gespeichert');
await stale.locator('#actions-close').click();
await stale.screenshot({ path: `${OUT}/10-stale-warning.png` });
assert.deepEqual(staleErrors, [], 'keine Fehler im Veraltet-Fall:\n' + staleErrors.join('\n'));
await stale.close();

/* 15) Der hartnäckigere Fall: Das Gerät stellt einen Wert zwar gerade eben
   zu, gemessen wurde er aber vor Minuten (iOS-Puffer nach dem Aufwachen).
   Die App muss weiterfragen, bis ein wirklich junger Fix kommt. */
const buffered = await ctx.newPage();
await buffered.addInitScript(() => {
  const geo = navigator.geolocation;
  const realGet = geo.getCurrentPosition.bind(geo);
  const realWatch = geo.watchPosition.bind(geo);
  const stamp = (p, ts) => ({ coords: p.coords, timestamp: ts });
  // Das Gerät liefert Werte, die vor 5 Minuten gemessen wurden – so wie ein
  // iPhone direkt nach dem Aufwachen. Erst ab `freshFrom` misst es wirklich neu.
  window.__freshFrom = Infinity;
  const maybeStale = p => Date.now() >= window.__freshFrom ? p : stamp(p, Date.now() - 300000);
  geo.getCurrentPosition = (ok, err, opts) => realGet(p => ok(maybeStale(p)), err, opts);
  geo.watchPosition = (ok, err, opts) => realWatch(p => ok(maybeStale(p)), err, opts);
});
await ctx.setGeolocation({ latitude: POS_A.lat, longitude: POS_A.lon, accuracy: 5 });
await buffered.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
await buffered.evaluate(() => { indexedDB.deleteDatabase('campmap'); localStorage.clear(); });
await buffered.reload({ waitUntil: 'networkidle' });
await buffered.locator('#file-plan').setInputFiles(path.join(here, 'demo-plan.png'));
await buffered.waitForFunction(
  () => window.__app.state.plan && window.__app.state.plan.w === 1200, null, { timeout: 15000 });
await buffered.waitForFunction(() => window.__app.state.pos !== null, null, { timeout: 15000 });

// Trotz eben eingetroffener Werte muss die App das als "alt" erkennen
const agedOut = await buffered.evaluate(() => window.__app.state.pos.ts < Date.now() - 200000);
assert.ok(agedOut, 'Testaufbau liefert alt gemessene Werte');
await buffered.waitForFunction(
  () => /alt/.test(document.querySelector('#status .txt').textContent), null, { timeout: 12000 });

await buffered.locator('#btn-calib').click();
await buffered.waitForTimeout(200);
const b3 = await buffered.locator('#stage').boundingBox();
const tapAt = Date.now();
await buffered.mouse.click(b3.x + b3.width / 2, b3.y + b3.height / 2);

// Solange nur gepufferte Werte kommen, darf nichts gespeichert werden
await buffered.waitForTimeout(3000);
assert.equal(await buffered.evaluate(() => window.__app.state.calib.length), 0,
  'gepufferter Wert wird nicht als Kalibrierpunkt genommen');

// Jetzt misst das Gerät wirklich neu – die App muss den Punkt übernehmen.
// Der Mock liefert nur bei geänderter Position neue Callbacks, deshalb ein
// kleiner Versatz (in echt bewegt man sich ja auch).
await buffered.evaluate(() => { window.__freshFrom = Date.now(); });
await ctx.setGeolocation({ latitude: POS_A.lat + 0.00003, longitude: POS_A.lon + 0.00003, accuracy: 5 });
await buffered.waitForFunction(() => window.__app.state.calib.length === 1, null, { timeout: 30000 });
assert.ok(Date.now() - tapAt > 3000, 'App hat auf die frische Messung gewartet');
const freshAge = await buffered.evaluate(() => Date.now() - window.__app.state.pos.ts);
assert.ok(freshAge < 20000, `gespeichert wurde ein junger Fix (${Math.round(freshAge / 1000)} s)`);
await buffered.close();

/* 16) In-App-Browser erkennen: WKWebView einer fremden App (kein "Safari/"
   im User-Agent) bekommt den Hinweis, echtes Safari und die Home-Bildschirm-
   App nicht. */
const UA_WEBVIEW = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const UA_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
for (const [ua, expectHint] of [[UA_WEBVIEW, true], [UA_SAFARI, false]]) {
  const c2 = await browser.newContext({
    userAgent: ua, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    permissions: ['geolocation'], geolocation: { latitude: POS_A.lat, longitude: POS_A.lon, accuracy: 6 }
  });
  const p2 = await c2.newPage();
  await p2.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
  await p2.waitForFunction(() => window.__app && window.__app.state.env !== null, null, { timeout: 15000 });
  const env = await p2.evaluate(() => window.__app.state.env);
  assert.equal(env.ios, true, 'iPhone erkannt');
  assert.equal(env.inAppWebView, expectHint, `In-App-Browser=${expectHint} für ${ua.slice(-40)}`);
  const bannerText = await p2.locator('#banner').textContent();
  assert.equal(/In Safari öffnen/.test(bannerText) && !(await p2.locator('#banner').isHidden()), expectHint,
    'Hinweis nur im In-App-Browser');
  if (expectHint) {
    await p2.locator('#btn-menu').click();
    await p2.waitForTimeout(300);
    const diag = await p2.locator('#diag-log').textContent();
    assert.match(diag, /In-App-Browser: true/, 'Diagnose nennt die Umgebung');
    assert.match(diag, /Letzte Meldungen/, 'Diagnose listet Standortmeldungen');
    await p2.screenshot({ path: `${OUT}/11-diagnose.png` });
  }
  await c2.close();
}

assert.deepEqual(errors, [], 'keine Konsolenfehler:\n' + errors.join('\n'));

await browser.close();
console.log('BROWSER-TESTS OK');
