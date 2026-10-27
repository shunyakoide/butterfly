import * as THREE from 'three/webgpu';
import { uniform, screenUV, step, mix, vec3, smoothstep, luminance, clamp } from 'three/tsl';

// An analysis overlay, as if the butterfly were being tracked and measured: a network of points on
// its wings and body joined by thin lines with drifting numbers, two magnified insets (one thermal,
// one X-ray) wired to the part they show, a scatter of ASCII noise around it and captions in the
// corners. Lines and text are a 2D canvas over the scene; the insets are drawn in the post pass by
// re-reading the rendered frame at a magnified position, so the overlay costs next to nothing.

const ZOOM = 2.6;
const INSET_HOLD = 6; // s an inset stays on one part before moving to another
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const ASCII = '+-:.#*%=';

// Points on the butterfly, in the local frames of its parts: a few along each wing's outline (spread
// round it), the head and the abdomen tip.
function anchorsOf(bf) {
  const list = [];
  bf.pivots.forEach((p) => {
    const mesh = p.children[0], pts = bf.wings[p.userData.hind ? 1 : 0].pts;
    for (let k = 0; k < 4; k++) list.push({ obj: mesh, local: new THREE.Vector3(pts[Math.floor((k + 0.5) / 4 * pts.length)].x, pts[Math.floor((k + 0.5) / 4 * pts.length)].y, 0) });
    list.push({ obj: mesh, local: new THREE.Vector3(pts[0].x * 0.5, pts[0].y * 0.5, 0) }); // mid-wing
  });
  list.push({ obj: bf.antennae[0], local: new THREE.Vector3() }); // head
  list.push({ obj: bf.abdomen, local: new THREE.Vector3(0, -0.024, 0) }); // abdomen tip
  return list;
}

const num = () => (Math.random() < 0.3 ? (Math.random() * 3000 - 500).toFixed(3) : (Math.random() * 200 - 100).toFixed(Math.random() < 0.5 ? 4 : 6));

export function buildOverlay({ camera, bf, frame }) {
  const canvas = document.createElement('canvas');
  Object.assign(canvas.style, { position: 'fixed', inset: '0', pointerEvents: 'none' });
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const anchors = anchorsOf(bf);
  // Each anchor joins its two nearest on screen; some carry a number, some a small empty box.
  const decor = anchors.map(() => ({ label: Math.random() < 0.6 ? num() : null, box: Math.random() < 0.35 }));
  let enabled = false;

  // ---------- insets, in the post pass ----------
  const insets = [0, 1].map((i) => ({ rect: uniform(new THREE.Vector4()), centre: uniform(new THREE.Vector2()), alpha: uniform(0), anchor: i * 5, t: i * INSET_HOLD / 2 }));
  const thermal = (c) => {
    const t = clamp(luminance(c).mul(1.6), 0, 1);
    let col = mix(vec3(0.02, 0, 0.12), vec3(0.1, 0.25, 0.95), smoothstep(0, 0.25, t));
    col = mix(col, vec3(0.95, 0.18, 0.1), smoothstep(0.25, 0.5, t));
    col = mix(col, vec3(1, 0.62, 0.12), smoothstep(0.5, 0.75, t));
    return mix(col, vec3(1, 1, 0.85), smoothstep(0.75, 1, t)).mul(1.4);
  };
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

  // ---------- per frame ----------
  const v = new THREE.Vector3();
  let last = 0, nextNumbers = 0;
  function update(t) {
    const dt = Math.min(t - last, 0.1); last = t;
    const w = innerWidth, h = innerHeight, dpr = Math.min(devicePixelRatio, 2);
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const show = enabled && bf.group.visible;
    for (const s of insets) s.alpha.value = THREE.MathUtils.damp(s.alpha.value, show ? 1 : 0, 6, dt);
    if (!show) return;

    bf.group.updateMatrixWorld();
    const pts = anchors.map((a) => {
      v.copy(a.local); a.obj.localToWorld(v); v.project(camera);
      return { x: (v.x * 0.5 + 0.5) * w, y: (0.5 - v.y * 0.5) * h };
    });
    if (t > nextNumbers) { nextNumbers = t + 0.25; for (const d of decor) if (d.label && Math.random() < 0.3) d.label = num(); }

    ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 0.75;
    ctx.font = `9px ${MONO}`;
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
      if (s.t > INSET_HOLD) { s.t = 0; s.anchor = Math.floor(Math.random() * pts.length); s.alpha.value = 0; }
      const a = pts[s.anchor];
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
      ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.font = `10px ${MONO}`;
      ctx.fillText(i === 0 ? 'THERMAL // λ 495nm' : 'X-RAY // OBJECT (1)', L, T - 8);
      ctx.globalAlpha = 1;
    });

    // Captions in the corners, and the time.
    ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.font = `11px ${MONO}`;
    const now = new Date(), pad = (n) => String(n).padStart(2, '0');
    ctx.fillText('SURVEILLANCE AESTHETICS', 20, 30);
    ctx.fillText('morpho.peleides  —  tracking', 20, 46);
    ctx.textAlign = 'right';
    ctx.fillText('BIOMETRIC OVERLAY', w - 20, 30);
    ctx.fillText(`${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())}  ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`, w - 20, 46);
    ctx.fillText(`x ${bf.group.position.x.toFixed(4)}  y ${bf.group.position.y.toFixed(4)}  z ${bf.group.position.z.toFixed(4)}`, w - 20, h - 20);
    ctx.textAlign = 'left';
  }

  return { apply, update, toggle: (on = !enabled) => (enabled = on), get enabled() { return enabled; } };
}
