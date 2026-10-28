import * as THREE from 'three/webgpu';
import { uniform, screenUV, screenSize, step, mix, vec2, vec3, smoothstep, luminance, clamp, hash, sqrt } from 'three/tsl';
import { buildCloud } from './cloud.js';

// Overlays that redraw the frame, one at a time:
//  - scan: as if the butterfly were being tracked and measured, a network of points on its wings and
//    body joined by thin lines with drifting numbers, two magnified insets (one thermal, one X-ray)
//    wired to the part they show, a scatter of ASCII noise and captions in the corners;
//  - dither: the whole frame as a grey hexagonal dot screen, with yellow characters blinking on a grid;
//  - plot: a black chart with ruled edges, the scene a grey dither of points, and the butterfly's parts
//    as lime bubbles sized by what they measure, named and wired to the thorax;
//  - cloud: the butterfly as a 3D scan's point cloud coming apart in threads (cloud.js), on black.
// Lines and text are a 2D canvas over the scene; the rest is drawn in the post pass from the rendered
// frame (and the butterfly's mask), so the overlays cost next to nothing.

export const MODES = ['scan', 'dither', 'plot', 'cloud'];
const ZOOM = 2.6;
const INSET_HOLD = 6; // s an inset stays on one part before moving to another
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const ASCII = '+-:.#*%=';
const GLYPHS = 'ABCDEFGHJKMNPRSTWXYZabdefghjkmnqrstuy0123456789#$%&*+/(){}[]<>=?';
const YELLOW = [236, 240, 40];
const LIME = 'rgb(168,214,38)';
const EXPOSURE = 30; // how bright the dark frame reads in the grey modes (est., by eye against the references)

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

// The plot's bubbles: each wing by its area, the abdomen tip by its swing, and the sun by its
// elevation. The thorax is the hub they are wired to, labelled with its height off the wall.
function partsOf(bf, sun) {
  const S = bf.group.scale.x, centroid = (pts) => pts.reduce((m, q) => m.add(q), new THREE.Vector2()).divideScalar(pts.length);
  const area = (pts) => Math.abs(pts.reduce((a, q, i) => { const r = pts[(i + 1) % pts.length]; return a + q.x * r.y - r.x * q.y; }, 0)) / 2;
  const deg = (r) => `${(r * 180 / Math.PI).toFixed(1)}°`;
  const list = bf.pivots.map((p) => {
    const hind = p.userData.hind, pts = bf.wings[hind ? 1 : 0].pts, c = centroid(pts), cm2 = area(pts) * S * S * 1e4;
    return { name: `${hind ? 'hind' : 'fore'}wing-${p.userData.side > 0 ? 'right' : 'left'}`, obj: p.children[0],
      local: new THREE.Vector3(c.x, c.y, 0), r: Math.sqrt(cm2) * 8, value: () => `${cm2.toFixed(1)} cm²` };
  });
  list.push({ name: 'abdomen', obj: bf.abdomen, local: new THREE.Vector3(0, -0.024, 0), r: 7, value: () => `swing ${deg(bf.abdomen.rotation.x)}` });
  list.push({ name: 'sun', world: () => bf.group.position.clone().addScaledVector(sun, 0.045), r: 14, value: () => `elev ${deg(Math.asin(sun.y))}` });
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

// frame, smooth and mask: the scene pass's colour, a blurred copy and the butterfly's mask; sun: the unit vector toward the sun;
// pixelRatio: the renderer's, so the dot and dither cells keep their size in CSS pixels.
export function buildOverlay({ camera, bf, frame, smooth, mask, sun, pixelRatio }) {
  const canvas = document.createElement('canvas');
  Object.assign(canvas.style, { position: 'fixed', inset: '0', pointerEvents: 'none' });
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const anchors = anchorsOf(bf), spots = blueSpots(bf), parts = partsOf(bf, sun);
  // Each anchor joins its two nearest on screen; some carry a number, some a small empty box.
  const decor = anchors.map(() => ({ label: Math.random() < 0.6 ? num() : null, box: Math.random() < 0.35 }));
  const cloud = buildCloud(bf);
  let mode = null;

  // ---------- in the post pass ----------
  const insets = [0, 1].map((i) => ({ rect: uniform(new THREE.Vector4()), centre: uniform(new THREE.Vector2()), alpha: uniform(0), anchor: i * 5, t: i * INSET_HOLD / 2 }));
  const on = Object.fromEntries(MODES.map((m) => [m, uniform(0)]));
  const dpr = uniform(1);
  const thermal = (c) => heat(clamp(luminance(c).mul(1.6), 0, 1));
  const xray = (c) => vec3(0.75, 0.9, 1).mul(smoothstep(0.02, 0.6, luminance(c)).pow(0.7)).mul(1.5);
  // Brightness 0..1 of the frame at uv, the dark scene lifted (a soft exposure curve): the butterfly
  // sharp, the rest from the blurred frame, so the wall's fine detail doesn't break into noise.
  const level = (uv) => {
    const l = mix(luminance(smooth.sample(uv).rgb), luminance(frame.sample(uv).rgb), mask.sample(uv).r).mul(EXPOSURE);
    return l.div(l.add(1));
  };

  // A hexagonal screen of dark dots on grey paper, each dot sized by the darkness under its centre.
  function dither() {
    const P = screenUV.mul(screenSize), s = dpr.mul(3.4);
    const r = vec2(s, s.mul(1.7320508)), h = r.mul(0.5);
    const a = P.mod(r).sub(h), b = P.sub(h).mod(r).sub(h);
    const g = a.dot(a).lessThan(b.dot(b)).select(a, b); // from the nearest dot's centre
    const dark = level(P.sub(g).div(screenSize)).oneMinus();
    const rad = sqrt(dark).mul(s).mul(0.62);
    const ink = smoothstep(rad.add(dpr.mul(0.5)), rad.sub(dpr.mul(0.5)), g.length());
    return mix(vec3(0.85), vec3(0.004), ink);
  }
  // Black, with the scene as scattered grey points (a random threshold per 2 px cell), brighter on the butterfly.
  function plot() {
    const P = screenUV.mul(screenSize), cell = P.div(dpr.mul(2)).floor();
    const uv = cell.add(0.5).mul(dpr.mul(2)).div(screenSize);
    // Only the brighter parts leave points, so most of the frame stays black.
    const t = smoothstep(0.7, 1, level(uv)).mul(0.5).add(mask.sample(uv).r.mul(0.45));
    return vec3(0.16).mul(step(hash(cell.x.add(cell.y.mul(4096))), t));
  }

  function apply(base) {
    let out = base;
    insets.forEach((s, i) => {
      const r = s.rect;
      const inside = step(r.x, screenUV.x).mul(step(screenUV.x, r.z)).mul(step(r.y, screenUV.y)).mul(step(screenUV.y, r.w));
      const uv = screenUV.sub(r.xy.add(r.zw).mul(0.5)).div(ZOOM).add(s.centre);
      const c = frame.sample(uv).rgb;
      out = mix(out, i === 0 ? thermal(c) : xray(c), inside.mul(s.alpha));
    });
    out = mix(out, dither(), on.dither);
    out = mix(out, plot(), on.plot);
    return mix(out, out.mul(mask.sample(screenUV).r), on.cloud); // only the points, on black
  }

  function set(m) {
    mode = m;
    for (const k of MODES) on[k].value = k === m ? 1 : 0;
    cloud.show(m === 'cloud');
  }

  // ---------- per frame ----------
  const v = new THREE.Vector3();
  let w = 0, h = 0, last = 0, nextNumbers = 0;
  const glyphs = []; // the dither's character grid: { ch, a, until }
  const toScreen = (a) => {
    if (a.world) v.copy(a.world()); else a.obj.localToWorld(v.copy(a.local));
    v.project(camera);
    return { x: (v.x * 0.5 + 0.5) * w, y: (0.5 - v.y * 0.5) * h };
  };
  const font = (px) => (ctx.font = `${px}px ${MONO}`);

  function update(t) {
    const dt = Math.min(t - last, 0.1); last = t;
    w = innerWidth; h = innerHeight;
    dpr.value = pixelRatio();
    const cdpr = Math.min(devicePixelRatio, 2);
    if (canvas.width !== w * cdpr || canvas.height !== h * cdpr) { canvas.width = w * cdpr; canvas.height = h * cdpr; }
    ctx.setTransform(cdpr, 0, 0, cdpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    for (const s of insets) s.alpha.value = THREE.MathUtils.damp(s.alpha.value, mode === 'scan' && bf.group.visible ? 1 : 0, 6, dt);
    bf.group.updateMatrixWorld();
    if (mode === 'scan') scan(t, dt);
    if (mode === 'dither') characters(t);
    if (mode === 'plot') chart();
  }

  // ---------- scan ----------
  function scan(t, dt) {
    if (!bf.group.visible) return;
    const pts = anchors.map(toScreen), targets = spots.map(toScreen);
    if (t > nextNumbers) { nextNumbers = t + 0.25; for (const d of decor) if (d.label && Math.random() < 0.3) d.label = num(); }

    ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 0.75;
    font(9);
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
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
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
      ctx.fillStyle = 'rgba(255,255,255,0.85)'; font(10);
      ctx.fillText(i === 0 ? 'THERMAL // λ 495nm' : 'X-RAY // OBJECT (1)', L, T - 8);
      ctx.globalAlpha = 1;
    });

    // Captions in the corners, and the time.
    ctx.fillStyle = 'rgba(255,255,255,0.8)'; font(11);
    const now = new Date(), pad = (n) => String(n).padStart(2, '0');
    ctx.fillText('SURVEILLANCE AESTHETICS', 20, 30);
    ctx.fillText(`morpho.${bf.species}  —  tracking`, 20, 46);
    ctx.textAlign = 'right';
    ctx.fillText('BIOMETRIC OVERLAY', w - 20, 30);
    ctx.fillText(`${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())}  ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`, w - 20, 46);
    ctx.fillText(`x ${bf.group.position.x.toFixed(4)}  y ${bf.group.position.y.toFixed(4)}  z ${bf.group.position.z.toFixed(4)}`, w - 20, h - 20);
    ctx.textAlign = 'left';
  }

  // ---------- dither: yellow characters on a grid, each lit for a while, some faint ----------
  function characters(t) {
    const C = 46, cols = Math.ceil(w / C), rows = Math.ceil(h / C);
    if (glyphs.length !== cols * rows) glyphs.splice(0, glyphs.length, ...Array.from({ length: cols * rows }, () => ({ ch: '', a: 0, until: 0 })));
    font(22); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    glyphs.forEach((g, i) => {
      if (t > g.until) {
        const lit = Math.random() < 0.1;
        g.ch = lit ? (Math.random() < 0.04 ? '▙' : GLYPHS[Math.floor(Math.random() * GLYPHS.length)]) : '';
        g.a = Math.random() < 0.3 ? 0.95 : 0.15 + 0.25 * Math.random();
        g.until = t + 0.2 + Math.random() * (lit ? 2.5 : 1.2);
      }
      if (!g.ch) return;
      ctx.fillStyle = `rgba(${YELLOW.join(',')},${g.a})`;
      ctx.fillText(g.ch, (i % cols + 0.5) * C, (Math.floor(i / cols) + 0.5) * C);
    });
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }

  // ---------- plot: ruled edges, and the butterfly's parts as bubbles ----------
  function chart() {
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1;
    font(11);
    // Ticks along the top and left, every 2.5% with a longer one every 12.5%, numbered 0 to 100.
    ctx.beginPath();
    for (let k = 0; k <= 40; k++) {
      const major = k % 5 === 0, x = k / 40 * w, y = k / 40 * h;
      ctx.moveTo(x, 0); ctx.lineTo(x, major ? 9 : 4);
      ctx.moveTo(0, y); ctx.lineTo(major ? 9 : 4, y);
    }
    // And rows of short marks across the field, as on a plotter's grid.
    for (let j = 1; j < 8; j++) for (let k = 1; k < 40; k++) {
      if ((j * 7 + k * 3) % 5 === 0) continue;
      const x = k / 40 * w, y = j / 8 * h;
      ctx.moveTo(x, y - 3); ctx.lineTo(x, y + 3);
    }
    ctx.stroke();
    ctx.textAlign = 'center';
    for (let k = 1; k <= 8; k++) ctx.fillText(String(Math.round(k * 12.5)), k / 8 * w - (k === 8 ? 12 : 0), 22);
    ctx.textAlign = 'left';
    for (let k = 1; k <= 7; k++) ctx.fillText(String(Math.round(100 - k * 12.5)), 14, k / 8 * h + 4);
    if (!bf.group.visible) return;

    const hub = toScreen({ obj: bf.group, local: new THREE.Vector3() });
    // Bubbles laid out round the hub, each in its own direction at its own distance (drifting slowly),
    // so they spread like a chart whatever the wings do; a faint lead goes to the part it measures.
    const R = Math.min(w, h) * 0.3, t = performance.now() / 1000;
    const at = parts.map((p, i) => {
      const a = i / parts.length * Math.PI * 2 + 0.4 + 0.08 * Math.sin(t * 0.3 + i), d = R * (0.7 + 0.45 * ((i * 0.618) % 1));
      return { ...p, part: toScreen(p),
        x: THREE.MathUtils.clamp(hub.x + Math.cos(a) * d, 60, w - 160), y: THREE.MathUtils.clamp(hub.y + Math.sin(a) * d * 0.8, 50, h - 60) };
    });
    ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 0.75; ctx.setLineDash([2, 3]);
    ctx.beginPath();
    for (const p of at) { ctx.moveTo(p.x, p.y); ctx.lineTo(p.part.x, p.part.y); ctx.moveTo(p.part.x + 2.5, p.part.y); ctx.arc(p.part.x, p.part.y, 2.5, 0, Math.PI * 2); }
    ctx.stroke(); ctx.setLineDash([]);
    // Wires: straight from the hub to each, and a loop of arcs bowing out round them in turn.
    ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (const p of at) { ctx.moveTo(hub.x, hub.y); ctx.lineTo(p.x, p.y); }
    const ring = [...at].sort((a, b) => Math.atan2(a.y - hub.y, a.x - hub.x) - Math.atan2(b.y - hub.y, b.x - hub.x));
    ring.forEach((p, i) => {
      const q = ring[(i + 1) % ring.length], mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
      const out = Math.hypot(mx - hub.x, my - hub.y) || 1, bow = 0.6 * Math.hypot(q.x - p.x, q.y - p.y);
      ctx.moveTo(p.x, p.y); ctx.quadraticCurveTo(mx + (mx - hub.x) / out * bow, my + (my - hub.y) / out * bow, q.x, q.y);
    });
    ctx.stroke();
    // Bubbles, then their names and values over them.
    ctx.fillStyle = LIME;
    for (const p of [{ x: hub.x, y: hub.y, r: 7 }, ...at]) { ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = '#fff'; font(13);
    for (const p of at) {
      ctx.fillText(p.name, p.x - p.r * 0.6, p.y - 2);
      ctx.fillText(p.value(), p.x - p.r * 0.6, p.y + 14);
    }
    ctx.textAlign = 'right';
    ctx.fillText('thorax', hub.x - 12, hub.y - 2);
    ctx.fillText(`z ${(bf.group.position.z * 1000).toFixed(1)} mm`, hub.x - 12, hub.y + 14);
    ctx.textAlign = 'left';
  }

  return { apply, update, set, get mode() { return mode; } };
}
