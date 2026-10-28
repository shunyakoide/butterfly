import * as THREE from 'three/webgpu';
import { uniform, screenUV, step, mix, vec3, smoothstep, luminance, clamp } from 'three/tsl';
import { N_EFF, SIGMA_ALONG, SIGMA_ACROSS, bandRGB } from './morpho.js';

// Analysis overlays, as if the butterfly were being watched by instruments. One at a time:
//  - scan: a network of points on its wings and body joined by thin lines with drifting numbers, two
//    magnified insets (one thermal, one X-ray) wired to the part they show, and ASCII noise;
//  - measure: its wingspan and forewing length as dimension lines, a 10 mm scale bar, and the wing
//    angle over the last two seconds with the beat frequency read from it;
//  - track: where it has flown, its speed, the path it means to take and where it will land;
//  - spectrum: the reflectance of the forewing's blue at the angle it is seen and lit at, from the
//    same interference formula the wing material uses (morpho.js);
//  - target: a box that chases it, locks on while it rests and loses it when it leaves the frame.
// Lines and text are a 2D canvas over the scene; the scan insets are drawn in the post pass by
// re-reading the rendered frame at a magnified position, so the overlays cost next to nothing.

export const MODES = ['scan', 'measure', 'track', 'spectrum', 'target'];
const TITLES = { scan: 'SURVEILLANCE AESTHETICS', measure: 'MORPHOMETRICS', track: 'FLIGHT PATH', spectrum: 'STRUCTURAL COLOUR', target: 'TARGET ACQUISITION' };
const ZOOM = 2.6;
const INSET_HOLD = 6; // s an inset stays on one part before moving to another
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const ASCII = '+-:.#*%=';
const HISTORY = 2; // s of wing angle on the measure chart
const TRAIL = 6;   // s a flown path stays on the track overlay
const SIGMA = (SIGMA_ALONG + SIGMA_ACROSS) / 2; // est.: the ridge band's spread, averaged over both planes
const WHITE = 'rgba(255,255,255,0.85)', FAINT = 'rgba(255,255,255,0.35)';

// Points on the butterfly, in the local frames of its parts: a few along each wing's outline (spread
// round it), the head and the abdomen tip.
function anchorsOf(bf) {
  const list = [];
  bf.pivots.forEach((p) => {
    const mesh = p.children[0], pts = bf.wings[p.userData.hind ? 1 : 0].pts;
    for (let k = 0; k < 4; k++) {
      const q = pts[Math.floor((k + 0.5) / 4 * pts.length)];
      list.push({ obj: mesh, local: new THREE.Vector3(q.x, q.y, 0) });
    }
    list.push({ obj: mesh, local: new THREE.Vector3(pts[0].x * 0.5, pts[0].y * 0.5, 0) }); // mid-wing
  });
  list.push({ obj: bf.antennae[0], local: new THREE.Vector3() }); // head
  list.push({ obj: bf.abdomen, local: new THREE.Vector3(0, -0.024, 0) }); // abdomen tip
  return list;
}

// What the insets magnify: points from the blue middle of each wing out to where the blue meets the
// black border, 15-70% of the way from its centre (the outline's mean) to its edge; right at the edge
// there is little but fringe hairs.
function blueSpots(bf) {
  const list = [];
  bf.pivots.forEach((p) => {
    const mesh = p.children[0], pts = bf.wings[p.userData.hind ? 1 : 0].pts;
    const c = pts.reduce((m, q) => m.add(q), new THREE.Vector2()).divideScalar(pts.length);
    for (let k = 0; k < 6; k++) {
      const e = pts[Math.floor((k + 0.5) / 6 * pts.length)], f = 0.15 + 0.55 * Math.random();
      list.push({ obj: mesh, local: new THREE.Vector3(c.x + (e.x - c.x) * f, c.y + (e.y - c.y) * f, 0) });
    }
  });
  return list;
}

// A thermal camera's palette for t in 0..1: deep blue, blue, red, orange, near white.
export function heat(t) {
  let col = mix(vec3(0.02, 0, 0.12), vec3(0.1, 0.25, 0.95), smoothstep(0, 0.25, t));
  col = mix(col, vec3(0.95, 0.18, 0.1), smoothstep(0.25, 0.5, t));
  col = mix(col, vec3(1, 0.62, 0.12), smoothstep(0.5, 0.75, t));
  return mix(col, vec3(1, 1, 0.85), smoothstep(0.75, 1, t)).mul(1.4);
}

const num = () => (Math.random() < 0.3 ? (Math.random() * 3000 - 500).toFixed(3) : (Math.random() * 200 - 100).toFixed(Math.random() < 0.5 ? 4 : 6));

// The colour of each wavelength on the spectrum chart, 380-700 nm in 2 nm steps.
const SPECTRUM_NM = Array.from({ length: 161 }, (_, i) => 380 + 2 * i);
const SPECTRUM_RGB = SPECTRUM_NM.map((l) => {
  const c = bandRGB(l), m = Math.max(...c) || 1;
  return `rgb(${c.map((v) => Math.round(255 * Math.pow(v / m, 1 / 2.2))).join(',')})`;
});

// state() is the flight state (flight.js), sun the unit vector toward the sun.
export function buildOverlay({ camera, bf, frame, state, sun }) {
  const canvas = document.createElement('canvas');
  Object.assign(canvas.style, { position: 'fixed', inset: '0', pointerEvents: 'none' });
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const anchors = anchorsOf(bf), spots = blueSpots(bf);
  // Each anchor joins its two nearest on screen; some carry a number, some a small empty box.
  const decor = anchors.map(() => ({ label: Math.random() < 0.6 ? num() : null, box: Math.random() < 0.35 }));
  let mode = null;

  // The forewing's apex (its outline's outermost point) and the middle of its blue, in the wing's frame.
  const forePts = bf.wings[0].pts;
  const apex = forePts.reduce((a, q) => (q.x > a.x ? q : a));
  const apexLocal = new THREE.Vector3(apex.x, apex.y, 0);
  const centre = forePts.reduce((m, q) => m.add(q), new THREE.Vector2()).divideScalar(forePts.length);
  const centreLocal = new THREE.Vector3(centre.x, centre.y, 0);
  const [rightFore, , leftFore] = bf.pivots.map((p) => p.children[0]);

  // ---------- insets (scan), in the post pass ----------
  const insets = [0, 1].map((i) => ({ rect: uniform(new THREE.Vector4()), centre: uniform(new THREE.Vector2()), alpha: uniform(0), anchor: i * 5, t: i * INSET_HOLD / 2 }));
  const thermal = (c) => heat(clamp(luminance(c).mul(1.6), 0, 1));
  const xray = (c) => vec3(0.75, 0.9, 1).mul(smoothstep(0.02, 0.6, luminance(c)).pow(0.7)).mul(1.5);
  function apply(base) {
    let out = base;
    insets.forEach((s, i) => {
      const r = s.rect;
      const inside = step(r.x, screenUV.x).mul(step(screenUV.x, r.z)).mul(step(r.y, screenUV.y)).mul(step(screenUV.y, r.w));
      const uv = screenUV.sub(r.xy.add(r.zw).mul(0.5)).div(ZOOM).add(s.centre);
      const c = frame.sample(uv).rgb;
      out = mix(out, i === 0 ? thermal(c) : xray(c), inside.mul(s.alpha));
    });
    return out;
  }

  // ---------- what the overlays remember between frames ----------
  const angles = [];  // { t, a }: the right forewing's angle, for the measure chart
  const trail = [];   // { t, p }: where it has been, for the track overlay
  const events = [];  // { t, p, label }: take-offs and touchdowns
  const box = { x0: 0, y0: 0, x1: 0, y1: 0, set: false, lockedAt: -1, conf: 0.9 };
  const id = `MRP-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
  let lastMode = null, restSince = 0;

  // ---------- per frame ----------
  const v = new THREE.Vector3(), P = new THREE.Vector3();
  let w = 0, h = 0, last = 0, nextNumbers = 0;
  const screen = (world) => { P.copy(world).project(camera); return { x: (P.x * 0.5 + 0.5) * w, y: (0.5 - P.y * 0.5) * h }; };
  const toScreen = (a) => screen(a.obj.localToWorld(v.copy(a.local)));
  const worldOf = (obj, local) => obj.localToWorld(local.clone());
  const font = (px) => (ctx.font = `${px}px ${MONO}`);
  function line(ax, ay, bx, by) { ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); }
  function reticle(x, y, r) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.moveTo(x - r - 5, y); ctx.lineTo(x - r + 3, y); ctx.moveTo(x + r - 3, y); ctx.lineTo(x + r + 5, y);
    ctx.moveTo(x, y - r - 5); ctx.lineTo(x, y - r + 3); ctx.moveTo(x, y + r - 3); ctx.lineTo(x, y + r + 5);
    ctx.stroke();
  }

  function update(t) {
    const dt = Math.min(t - last, 0.1); last = t;
    w = innerWidth; h = innerHeight;
    const dpr = Math.min(devicePixelRatio, 2);
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    for (const s of insets) s.alpha.value = THREE.MathUtils.damp(s.alpha.value, mode === 'scan' && bf.group.visible ? 1 : 0, 6, dt);
    bf.group.updateMatrixWorld();
    remember(t);
    if (!mode) return;

    ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.fillStyle = WHITE; ctx.lineWidth = 0.75; ctx.setLineDash([]);
    font(9);
    ({ scan, measure, track, spectrum, target })[mode](t, dt);

    // Captions in the corners, and the time.
    ctx.globalAlpha = 1; ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,0.8)'; font(11);
    const now = new Date(), pad = (n) => String(n).padStart(2, '0');
    ctx.fillText(TITLES[mode], 20, 30);
    ctx.fillText(`morpho.${bf.species}  —  ${mode}`, 20, 46);
    ctx.textAlign = 'right';
    ctx.fillText('BIOMETRIC OVERLAY', w - 20, 30);
    ctx.fillText(`${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())}  ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`, w - 20, 46);
    ctx.fillText(`x ${bf.group.position.x.toFixed(4)}  y ${bf.group.position.y.toFixed(4)}  z ${bf.group.position.z.toFixed(4)}`, w - 20, h - 20);
    ctx.textAlign = 'left';
  }

  // Kept whether or not an overlay is showing, so switching to one shows the recent past.
  function remember(t) {
    const st = state();
    angles.push({ t, a: -rightFore.parent.rotation.y });
    while (angles[0].t < t - HISTORY) angles.shift();
    const p = bf.group.position;
    if (bf.group.visible && (!trail.length || trail.at(-1).p.distanceTo(p) > 0.0005)) trail.push({ t, p: p.clone() });
    while (trail.length && trail[0].t < t - TRAIL) trail.shift();
    if (st.mode !== lastMode) {
      if (st.mode === 'takeoff') events.push({ t, p: p.clone(), label: 'TAKEOFF' });
      if (st.mode === 'rest' && lastMode) { events.push({ t, p: p.clone(), label: 'TOUCHDOWN' }); restSince = t; }
      lastMode = st.mode;
    }
    while (events.length && events[0].t < t - TRAIL) events.shift();
  }

  // ---------- scan ----------
  function scan(t, dt) {
    const pts = anchors.map(toScreen), targets = spots.map(toScreen);
    if (t > nextNumbers) { nextNumbers = t + 0.25; for (const d of decor) if (d.label && Math.random() < 0.3) d.label = num(); }
    if (!bf.group.visible) return;
    // The network.
    ctx.beginPath();
    pts.forEach((p, i) => {
      const near = pts.map((q, j) => [Math.hypot(q.x - p.x, q.y - p.y), j]).filter(([, j]) => j !== i).sort((a, b) => a[0] - b[0]);
      for (const [, j] of near.slice(0, 2)) { ctx.moveTo(p.x, p.y); ctx.lineTo(pts[j].x, pts[j].y); }
    });
    ctx.stroke();
    pts.forEach((p, i) => {
      ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, Math.PI * 2); ctx.stroke();
      const d = decor[i];
      if (d.box) ctx.strokeRect(p.x + 6, p.y - 16, 22, 12);
      if (d.label) ctx.fillText(d.label, p.x + 6, p.y - 6);
    });

    // ASCII noise around the butterfly's bounds.
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    ctx.fillStyle = FAINT;
    for (let k = 0; k < 140; k++) {
      const x = x0 - 40 + Math.random() * (x1 - x0 + 80), y = y0 - 30 + Math.random() * (y1 - y0 + 60);
      ctx.fillText(ASCII[Math.floor(Math.random() * ASCII.length)], Math.round(x / 7) * 7, Math.round(y / 10) * 10);
    }

    // Insets: hold on one part, then jump to another, placed to the side of it, inside the frame.
    const size = Math.min(w, h) * 0.24;
    insets.forEach((s, i) => {
      s.t += dt;
      if (s.t > INSET_HOLD) { s.t = 0; s.anchor = Math.floor(Math.random() * targets.length); s.alpha.value = 0; }
      const a = targets[s.anchor];
      const side = i === 0 ? -1 : 1;
      const cx = THREE.MathUtils.clamp(a.x + side * size * 1.1, size / 2 + 12, w - size / 2 - 12);
      const cy = THREE.MathUtils.clamp(a.y + (i === 0 ? -0.6 : 0.6) * size, size / 2 + 40, h - size / 2 - 40);
      const L = cx - size / 2, T = cy - size / 2;
      s.rect.value.set(L / w, T / h, (L + size) / w, (T + size) / h);
      s.centre.value.set(a.x / w, a.y / h);
      ctx.globalAlpha = s.alpha.value;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1;
      ctx.strokeRect(L, T, size, size);
      for (const [qx, qy] of [[L, T], [L + size, T], [L, T + size], [L + size, T + size]]) ctx.strokeRect(qx - 7, qy - 7, 14, 14);
      // Crosshair over the magnified part, and the wire back to it.
      ctx.beginPath(); ctx.arc(cx, cy, size * 0.12, 0, Math.PI * 2);
      ctx.moveTo(cx - 6, cy); ctx.lineTo(cx + 6, cy); ctx.moveTo(cx, cy - 6); ctx.lineTo(cx, cy + 6);
      ctx.moveTo(a.x, a.y); ctx.lineTo(side < 0 ? L + size : L, T + size / 2);
      ctx.stroke();
      ctx.fillStyle = WHITE; font(10);
      ctx.fillText(i === 0 ? 'THERMAL // λ 495nm' : 'X-RAY // OBJECT (1)', L, T - 8);
      ctx.globalAlpha = 1;
    });
  }

  // ---------- measure ----------
  // A dimension line between screen points a and b, set off by `off` px to one side, with its label.
  function dimension(a, b, off, label) {
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len * off, ny = dx / len * off;
    const A = { x: a.x + nx, y: a.y + ny }, B = { x: b.x + nx, y: b.y + ny };
    ctx.strokeStyle = FAINT;
    line(a.x, a.y, A.x + nx * 0.15, A.y + ny * 0.15); line(b.x, b.y, B.x + nx * 0.15, B.y + ny * 0.15);
    ctx.strokeStyle = WHITE;
    line(A.x, A.y, B.x, B.y);
    for (const E of [A, B]) line(E.x - 4, E.y + 4, E.x + 4, E.y - 4); // architectural ticks
    ctx.textAlign = 'center';
    ctx.fillText(label, (A.x + B.x) / 2 + nx * 0.4, (A.y + B.y) / 2 + ny * 0.4 + 3);
    ctx.textAlign = 'left';
  }

  function measure() {
    font(10);
    if (bf.group.visible) {
      const rApex = worldOf(rightFore, apexLocal), lApex = worldOf(leftFore, apexLocal), hinge = worldOf(rightFore.parent, new THREE.Vector3());
      const r = screen(rApex), l = screen(lApex), hg = screen(hinge);
      // Span between the forewing apexes as they are now: it shrinks as the wings close.
      // Set off well clear of the wings, on the side away from the body.
      const c = screen(bf.group.position), away = (a, b) => -Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) || 1;
      dimension(l, r, 70 * away(l, r), `SPAN ${(lApex.distanceTo(rApex) * 1000).toFixed(1)} mm`);
      dimension(hg, r, 45 * away(hg, r), `FW ${(hinge.distanceTo(rApex) * 1000).toFixed(1)} mm`);
    }

    // The wing angle over the last two seconds, and the beats in it.
    const cw = Math.min(260, w * 0.4), ch = 70, X = w - cw - 20, Y = h - ch - 60;
    // Above it, 10 mm at the butterfly's distance (its length depends only on that, not on where it is drawn).
    const across = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).multiplyScalar(0.005);
    const s0 = screen(bf.group.position.clone().sub(across)), s1 = screen(bf.group.position.clone().add(across));
    ctx.fillStyle = WHITE;
    ctx.fillRect(X, Y - 44, Math.hypot(s1.x - s0.x, s1.y - s0.y), 3);
    ctx.fillText('10 mm', X, Y - 50);
    ctx.strokeStyle = FAINT; ctx.strokeRect(X, Y, cw, ch);
    const yOf = (a) => Y + ch - (a + 0.3) / 2.2 * ch; // -17° .. 109°
    ctx.setLineDash([2, 3]); line(X, yOf(0), X + cw, yOf(0)); line(X, yOf(Math.PI / 2), X + cw, yOf(Math.PI / 2)); ctx.setLineDash([]);
    ctx.strokeStyle = WHITE; ctx.beginPath();
    const t1 = angles.at(-1).t;
    angles.forEach(({ t, a }, k) => ctx[k ? 'lineTo' : 'moveTo'](X + cw - (t1 - t) / HISTORY * cw, yOf(a)));
    ctx.stroke();
    // Beat frequency: upward crossings of the mean angle per second, once there are a few.
    const mean = angles.reduce((m, s) => m + s.a, 0) / angles.length;
    const up = angles.filter((s, k) => k && angles[k - 1].a < mean && s.a >= mean);
    const hz = up.length >= 3 ? (up.length - 1) / (up.at(-1).t - up[0].t) : null;
    const now = angles.at(-1).a * 180 / Math.PI;
    ctx.fillStyle = WHITE; font(10);
    ctx.fillText(`WING ELEVATION  θ ${now.toFixed(1)}°`, X, Y - 8);
    ctx.textAlign = 'right';
    ctx.fillText(hz ? `f ${hz.toFixed(1)} Hz` : 'f —', X + cw, Y - 8);
    ctx.fillStyle = FAINT; font(9);
    ctx.fillText('0°', X - 4, yOf(0) + 3); ctx.fillText('90°', X - 4, yOf(Math.PI / 2) + 3); ctx.fillText(`-${HISTORY} s`, X + 18, Y + ch + 12);
    ctx.textAlign = 'left';
  }

  // ---------- track ----------
  function track(t) {
    const st = state();
    // The path flown: dots fading with age, joined.
    let prev = null;
    for (const { t: at, p } of trail) {
      const s = screen(p), age = (t - at) / TRAIL;
      ctx.globalAlpha = 1 - age;
      if (prev) line(prev.x, prev.y, s.x, s.y);
      ctx.fillRect(s.x - 1, s.y - 1, 2, 2);
      prev = s;
    }
    ctx.globalAlpha = 1;
    for (const e of events) {
      const s = screen(e.p);
      ctx.globalAlpha = 1 - (t - e.t) / TRAIL;
      reticle(s.x, s.y, 6);
      ctx.fillText(`${e.label}  T-${(t - e.t).toFixed(1)}s`, s.x + 14, s.y - 8);
    }
    ctx.globalAlpha = 1;
    font(10);
    if (st.mode === 'takeoff' || st.mode === 'landing') {
      // The rest of the planned path, and where it ends.
      ctx.setLineDash([3, 4]); ctx.strokeStyle = FAINT; ctx.beginPath();
      for (let k = 0; k <= 30; k++) {
        const s = screen(st.curve.getPointAt(THREE.MathUtils.lerp(st.dist / st.length, 1, k / 30)));
        ctx[k ? 'lineTo' : 'moveTo'](s.x, s.y);
      }
      ctx.stroke(); ctx.setLineDash([]); ctx.strokeStyle = WHITE;
      const pos = screen(bf.group.position);
      if (st.vel) {
        const tip = screen(bf.group.position.clone().addScaledVector(st.vel, 0.04)); // where it will be in 40 ms
        line(pos.x, pos.y, tip.x, tip.y);
        const ang = Math.atan2(tip.y - pos.y, tip.x - pos.x);
        for (const da of [2.6, -2.6]) line(tip.x, tip.y, tip.x + 7 * Math.cos(ang + da), tip.y + 7 * Math.sin(ang + da));
        ctx.fillText(`${st.vel.length().toFixed(2)} m/s`, tip.x + 8, tip.y);
      }
      if (st.mode === 'landing') {
        const s = screen(st.rest.pos);
        reticle(s.x, s.y, 10);
        ctx.fillText(`ETA ${((st.length - st.dist) / st.speed).toFixed(2)} s`, s.x + 18, s.y + 4);
      }
    } else if (st.mode === 'rest') {
      const s = screen(st.rest.pos);
      reticle(s.x, s.y, 10);
      ctx.fillText(`REST ${(t - restSince).toFixed(1)} s`, s.x + 18, s.y - 2);
      if (st.stay > 0) ctx.fillText(`NEXT DEPARTURE ${st.stay.toFixed(0)} s`, s.x + 18, s.y + 11);
    } else ctx.fillText('OUT OF FRAME', 20, h - 20);
  }

  // ---------- spectrum ----------
  function spectrum() {
    // Measured at the middle of the right forewing's blue.
    const at = worldOf(rightFore, centreLocal);
    const N = new THREE.Vector3(0, 0, 1).transformDirection(rightFore.matrixWorld);
    const V = camera.position.clone().sub(at).normalize();
    const H = V.clone().add(sun).normalize();
    // As in morpho.js: the peak shifts with the angle inside the lamellae, λ = λ0·√(1 − sin²θ / n²),
    // and the ridge band falls off with the half vector's angle from the wing's normal.
    const lambda0 = bf.upperMats[0].lambda0.value;
    const cosLH = sun.dot(H), cosNH = N.dot(H);
    const peak = lambda0 * Math.sqrt(1 - (1 - cosLH * cosLH) / (N_EFF * N_EFF));
    const upper = N.dot(V) > 0 && N.dot(sun) > 0;
    const tanNH = Math.sqrt(Math.max(0, 1 - cosNH * cosNH)) / Math.max(cosNH, 1e-3);
    const amp = upper && cosNH > 0 ? Math.exp(-0.5 * (tanNH / SIGMA) ** 2) : 0;
    const band = (l, c) => Math.exp(-0.5 * ((l - c) / 38) ** 2); // ~90 nm FWHM, as bandRGB

    const pw = Math.min(300, w * 0.42), ph = 130, X = w - pw - 24, Y = Math.max(80, h * 0.5 - ph / 2);
    const xOf = (l) => X + (l - 380) / 320 * pw, yOf = (r) => Y + ph - r * (ph - 14);
    if (bf.group.visible) {
      const s = screen(at);
      ctx.strokeStyle = WHITE; reticle(s.x, s.y, 8);
      ctx.strokeStyle = FAINT; line(s.x + 13, s.y, X, Y + ph / 2);
    }
    ctx.strokeStyle = FAINT; ctx.strokeRect(X, Y, pw, ph);
    // The reflectance under the curve, in the colour of each wavelength.
    SPECTRUM_NM.forEach((l, i) => {
      const r = amp * band(l, peak);
      ctx.fillStyle = SPECTRUM_RGB[i]; ctx.globalAlpha = 0.85;
      ctx.fillRect(xOf(l), yOf(r), pw / 160 + 0.5, Y + ph - yOf(r));
    });
    ctx.globalAlpha = 1;
    // Seen and lit head-on, for comparison.
    ctx.strokeStyle = FAINT; ctx.setLineDash([2, 3]); ctx.beginPath();
    SPECTRUM_NM.forEach((l, i) => ctx[i ? 'lineTo' : 'moveTo'](xOf(l), yOf(band(l, lambda0))));
    ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = WHITE; ctx.beginPath();
    SPECTRUM_NM.forEach((l, i) => ctx[i ? 'lineTo' : 'moveTo'](xOf(l), yOf(amp * band(l, peak))));
    ctx.stroke();
    if (amp > 0.02) line(xOf(peak), Y + ph, xOf(peak), yOf(amp) - 6);

    ctx.fillStyle = FAINT; font(9); ctx.textAlign = 'center';
    for (const l of [400, 500, 600, 700]) ctx.fillText(String(l), xOf(l), Y + ph + 12);
    ctx.textAlign = 'left'; ctx.fillStyle = WHITE; font(10);
    ctx.fillText('REFLECTANCE // FOREWING', X, Y - 8);
    ctx.fillText(upper ? `λ peak ${peak.toFixed(0)} nm   R ${(amp * 100).toFixed(0)}%` : 'UNDERSIDE OR UNLIT  —  pigment only', X, Y + ph + 28);
    ctx.fillStyle = FAINT;
    ctx.fillText(`θ ${(Math.acos(Math.min(1, cosLH)) * 180 / Math.PI).toFixed(1)}°   n ${N_EFF}   λ0 ${lambda0.toFixed(0)} nm`, X, Y + ph + 42);
  }

  // ---------- target ----------
  function target(t, dt) {
    const st = state(), seen = bf.group.visible;
    if (seen) {
      // Kept inside the frame, so a butterfly at the edge is held at the edge.
      const pts = anchors.map(toScreen), pad = 14, cx = (x) => THREE.MathUtils.clamp(x, 70, w - 70), cy = (y) => THREE.MathUtils.clamp(y, 70, h - 70);
      const goal = { x0: cx(Math.min(...pts.map((p) => p.x)) - pad), y0: cy(Math.min(...pts.map((p) => p.y)) - pad),
        x1: cx(Math.max(...pts.map((p) => p.x)) + pad), y1: cy(Math.max(...pts.map((p) => p.y)) + pad) };
      // The box chases the butterfly rather than sticking to it.
      for (const k of ['x0', 'y0', 'x1', 'y1']) box[k] = box.set ? THREE.MathUtils.damp(box[k], goal[k], 9, dt) : goal[k];
      box.set = true;
    }
    if (!box.set) return;
    const status = !seen ? 'LOST' : st.mode === 'rest' ? 'LOCK' : 'TRACK';
    if (status === 'LOCK' && box.lockedAt < 0) box.lockedAt = t;
    if (status !== 'LOCK') box.lockedAt = -1;
    box.conf = THREE.MathUtils.damp(box.conf, status === 'LOCK' ? 0.98 : status === 'TRACK' ? 0.7 + 0.2 * Math.random() : 0, 3, dt);
    const { x0, y0, x1, y1 } = box, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, L = 14;

    ctx.globalAlpha = status === 'LOST' ? (Math.sin(t * 12) > 0 ? 0.8 : 0.3) : 1;
    // Lines out to the edges of the frame, broken around the box.
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    line(0, cy, x0 - 6, cy); line(x1 + 6, cy, w, cy); line(cx, 0, cx, y0 - 6); line(cx, y1 + 6, cx, h);
    ctx.strokeStyle = WHITE; ctx.lineWidth = 1.25;
    if (status === 'LOST') ctx.setLineDash([4, 4]);
    ctx.beginPath();
    for (const [x, y, sx, sy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]) {
      ctx.moveTo(x + sx * L, y); ctx.lineTo(x, y); ctx.lineTo(x, y + sy * L);
    }
    ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 0.75;
    line(cx - 4, cy, cx + 4, cy); line(cx, cy - 4, cx, cy + 4);
    // On locking, a square closing in on the box.
    const since = t - box.lockedAt;
    if (box.lockedAt >= 0 && since < 0.35) {
      const g = (1 - since / 0.35) * 30;
      ctx.globalAlpha = 1 - since / 0.35; ctx.strokeRect(x0 - g, y0 - g, x1 - x0 + 2 * g, y1 - y0 + 2 * g); ctx.globalAlpha = 1;
    }
    font(10); ctx.fillStyle = WHITE;
    ctx.fillText(id, x0, y0 - 8);
    ctx.textAlign = 'right';
    ctx.fillText(status, x1, y0 - 8);
    ctx.textAlign = 'left'; ctx.fillStyle = FAINT;
    ctx.fillText(`RNG ${camera.position.distanceTo(bf.group.position).toFixed(3)} m   CONF ${box.conf.toFixed(2)}`, x0, y1 + 16);
    ctx.globalAlpha = 1;
  }

  return { apply, update, set: (m) => (mode = m), get mode() { return mode; } };
}
