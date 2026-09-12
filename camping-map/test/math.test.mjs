/* Tests für den Rechenkern (Projektion, Kalibrierung, Koordinaten-Parser).
   Läuft ohne Browser: node --test camping-map/test/
   Der Mathe-Teil von app.js wird bis zur Zeile `window.CampMath` ausgeschnitten
   und in eine Funktion gewrappt, damit kein DOM nötig ist. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'app.js'), 'utf8');
const mathSrc = src.slice(0, src.indexOf('window.CampMath'));
const M = new Function(mathSrc + `
  return { project, unproject, solveTransform, applyTransform, invertTransform,
           latLonToPlan, planToLatLon, geoDistance, bearingDeg, parseCoords, compassName };
`)();

/* Ein künstlicher, exakt bekannter Plan: Maßstab und Nordrichtung vorgegeben. */
function truthMaker({ lat0 = 45.2938, lon0 = 13.5897, pxPerM = 2.5, rotDeg = 33, ox = 600, oy = 420 } = {}) {
  const th = rotDeg * Math.PI / 180;
  const ref = { lat: lat0, lon: lon0 };
  return (lat, lon) => {
    const m = M.project(lat, lon, ref);
    return {
      px: pxPerM * (Math.cos(th) * m.x - Math.sin(th) * m.y) + ox,
      py: pxPerM * (Math.sin(th) * m.x + Math.cos(th) * m.y) + oy
    };
  };
}

const P = (lat, lon, truth) => ({ lat, lon, ...truth(lat, lon) });

test('Projektion stimmt mit Haversine überein (<0,5 m auf 1 km)', () => {
  const ref = { lat: 45.2938, lon: 13.5897 };
  const a = { lat: 45.2938, lon: 13.5897 };
  const b = { lat: 45.3028, lon: 13.5977 };
  const ma = M.project(a.lat, a.lon, ref), mb = M.project(b.lat, b.lon, ref);
  const flat = Math.hypot(mb.x - ma.x, mb.y - ma.y);
  const hav = M.geoDistance(a.lat, a.lon, b.lat, b.lon);
  assert.ok(hav > 1000 && hav < 1300, `Testdistanz plausibel: ${hav}`);
  assert.ok(Math.abs(flat - hav) < 0.5, `Abweichung ${Math.abs(flat - hav).toFixed(3)} m`);
});

test('Zwei Kalibrierpunkte reichen für exakte Vorhersage', () => {
  const truth = truthMaker();
  const pts = [P(45.2938, 13.5897, truth), P(45.2985, 13.5951, truth)];
  const T = M.solveTransform(pts);
  assert.ok(T, 'Transformation gefunden');
  assert.equal(T.n, 2);

  const check = P(45.2960, 13.5980, truth);
  const got = M.latLonToPlan(T, check.lat, check.lon);
  const err = Math.hypot(got.px - check.px, got.py - check.py);
  assert.ok(err < 0.5, `Pixelfehler ${err.toFixed(3)}`);
  assert.ok(T.rms < 0.01, `RMS ${T.rms}`);
});

test('Nordrichtung und Maßstab werden korrekt abgeleitet', () => {
  for (const rotDeg of [0, 33, 120, 275]) {
    const truth = truthMaker({ rotDeg, pxPerM: 1.8 });
    const T = M.solveTransform([P(45.2938, 13.5897, truth), P(45.2985, 13.5951, truth)]);
    const dn = Math.abs(((T.northDeg - rotDeg + 540) % 360) - 180);   // kleinste Winkeldifferenz
    assert.ok(dn < 0.2, `Nord ${T.northDeg} statt ${rotDeg}`);
    assert.ok(Math.abs(T.pxPerMeter - 1.8) < 0.005, `Maßstab ${T.pxPerMeter}`);
  }
});

test('Vier Punkte: affine Lösung, kleine Restfehler', () => {
  const truth = truthMaker({ pxPerM: 3.1, rotDeg: 200 });
  const pts = [
    P(45.2938, 13.5897, truth), P(45.2985, 13.5951, truth),
    P(45.2905, 13.5960, truth), P(45.2970, 13.5880, truth)
  ];
  const T = M.solveTransform(pts);
  assert.ok(T, 'Transformation gefunden');
  assert.equal(T.n, 4);
  assert.ok(T.rms < 0.05, `RMS ${T.rms} m`);
  assert.equal(T.fellBack, false);
});

test('Drei Punkte: Restfehler ist blind, Kontrollfehler deckt den Ausreißer auf', () => {
  const truth = truthMaker();
  const pts = [
    P(45.2938, 13.5897, truth), P(45.2985, 13.5951, truth), P(45.2905, 13.5960, truth)
  ];
  pts[2].px += 25;   // 10 m daneben getippt (2,5 px/m)
  const T = M.solveTransform(pts);
  assert.ok(T, 'Transformation trotzdem berechnet');
  assert.ok(T.rms < 1e-6, 'affine Lösung geht exakt durch 3 Punkte – Restfehler taugt nicht');
  assert.ok(T.check, 'Kontrollfehler vorhanden');
  assert.ok(T.check.max > 8, `Kontrollfehler max ${T.check.max.toFixed(1)} m zeigt den Ausreißer`);
  assert.ok(T.check.mean > 3, `Kontrollfehler Ø ${T.check.mean.toFixed(1)} m`);
  // Bei nur drei Punkten schlägt ein Ausreißer auch auf die Nachbarn durch:
  // der größte Kontrollwert ist deshalb kein sicherer Fingerzeig auf den Schuldigen.
  assert.ok(T.checkErrors.every(e => e > 1), 'alle drei Punkte werden auffällig');
});

test('Kontrollfehler schlägt bei einem Ausreißer an – auch mit fünf Punkten', () => {
  const truth = truthMaker();
  const clean = () => [
    P(45.2938, 13.5897, truth), P(45.2985, 13.5951, truth), P(45.2905, 13.5960, truth),
    P(45.2970, 13.5880, truth), P(45.2925, 13.5930, truth)
  ];
  const good = M.solveTransform(clean());
  assert.ok(good.check.mean < 0.01, `saubere Punkte: Ø ${good.check.mean}`);

  const pts = clean();
  pts[3].py -= 30;   // 12 m daneben
  const bad = M.solveTransform(pts);
  assert.ok(bad.check.mean > 5, `mit Ausreißer: Ø ${bad.check.mean.toFixed(1)} m`);
  // Anmerkung: Weder Kontrollfehler noch Restfehler zeigen zuverlässig auf den
  // falschen Punkt – ein Fehler verteilt sich über die ganze Lösung. Das Maß
  // taugt als Warnung, nicht als Schuldzuweisung; das UI formuliert es so.
});

test('Vier gute Punkte: Kontrollfehler bleibt klein', () => {
  const truth = truthMaker({ pxPerM: 2.2, rotDeg: 77 });
  const pts = [
    P(45.2938, 13.5897, truth), P(45.2985, 13.5951, truth),
    P(45.2905, 13.5960, truth), P(45.2970, 13.5880, truth)
  ];
  const T = M.solveTransform(pts);
  assert.ok(T.check.mean < 0.01, `Kontrollfehler Ø ${T.check.mean}`);
});

test('Zwei Punkte liefern keinen Kontrollfehler (ehrlich statt geschönt)', () => {
  const truth = truthMaker();
  const T = M.solveTransform([P(45.2938, 13.5897, truth), P(45.2985, 13.5951, truth)]);
  assert.equal(T.check, null);
});

test('Kollineare Punkte fallen auf Drehung+Maßstab zurück statt zu entarten', () => {
  const truth = truthMaker();
  const pts = [
    P(45.2938, 13.5897, truth), P(45.2950, 13.5910, truth), P(45.2962, 13.5923, truth)
  ];
  const T = M.solveTransform(pts);
  assert.ok(T, 'Transformation gefunden');
  assert.equal(T.fellBack, true, 'affine Lösung verworfen');
  assert.ok(T.rms < 0.5, `RMS ${T.rms}`);
});

test('Hin- und Rückrechnung Plan <-> Koordinaten', () => {
  const truth = truthMaker();
  const T = M.solveTransform([P(45.2938, 13.5897, truth), P(45.2985, 13.5951, truth)]);
  for (const [px, py] of [[100, 100], [640, 480], [1500, 900]]) {
    const c = M.planToLatLon(T, px, py);
    const back = M.latLonToPlan(T, c.lat, c.lon);
    assert.ok(Math.hypot(back.px - px, back.py - py) < 1e-6, 'Rundgang exakt');
  }
});

test('Ein einzelner Punkt genügt nicht', () => {
  assert.equal(M.solveTransform([{ px: 1, py: 2, lat: 45, lon: 13 }]), null);
  assert.equal(M.solveTransform([]), null);
  assert.equal(M.solveTransform(null), null);
});

test('Zwei identische Punkte ergeben keine Transformation', () => {
  const p = { px: 10, py: 20, lat: 45.1, lon: 13.1 };
  assert.equal(M.solveTransform([p, { ...p }]), null);
});

test('Koordinaten-Parser', () => {
  const near = (c, lat, lon) => c && Math.abs(c.lat - lat) < 1e-4 && Math.abs(c.lon - lon) < 1e-4;
  assert.ok(near(M.parseCoords('45.2938, 13.5897'), 45.2938, 13.5897));
  assert.ok(near(M.parseCoords('45.2938 13.5897'), 45.2938, 13.5897));
  assert.ok(near(M.parseCoords('45,2938, 13,5897'), 45.2938, 13.5897));
  assert.ok(near(M.parseCoords('45,2938 13,5897'), 45.2938, 13.5897));
  assert.ok(near(M.parseCoords(' 45.2938,13.5897 '), 45.2938, 13.5897));
  assert.ok(near(M.parseCoords('45°17\'37.7"N 13°35\'22.9"E'), 45.29381, 13.58969));
  assert.ok(near(M.parseCoords('N 45 17.63 E 13 35.38'), 45.29383, 13.58967));
  assert.ok(near(M.parseCoords('13°35\'22.9"E 45°17\'37.7"N'), 45.29381, 13.58969));
  assert.ok(near(M.parseCoords('-33.8688, 151.2093'), -33.8688, 151.2093));
  assert.equal(M.parseCoords('Rezeption'), null);
  assert.equal(M.parseCoords('95.0, 13.0'), null);
  assert.equal(M.parseCoords(''), null);
});

test('Himmelsrichtungen', () => {
  assert.equal(M.compassName(0), 'N');
  assert.equal(M.compassName(90), 'O');
  assert.equal(M.compassName(181), 'S');
  assert.equal(M.compassName(315), 'NW');
  assert.equal(M.compassName(359), 'N');
});

test('Peilung zeigt in die richtige Richtung', () => {
  const b = M.bearingDeg(45.29, 13.58, 45.30, 13.58);
  assert.ok(Math.abs(b) < 0.5 || Math.abs(b - 360) < 0.5, `Nord erwartet, war ${b}`);
  const e = M.bearingDeg(45.29, 13.58, 45.29, 13.60);
  assert.ok(Math.abs(e - 90) < 0.5, `Ost erwartet, war ${e}`);
});
