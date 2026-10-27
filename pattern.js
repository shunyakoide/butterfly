import * as THREE from 'three/webgpu';
import { BOX, TEX } from './wing.js';
import { rng } from './noise.js';

// Wing patterns: seeded parameters, and painting them onto the wing textures in wing meters.

// ---------- pattern parameters ----------

export function morphoPattern(seed = Math.floor(Math.random() * 1e9)) {
  const r = rng(seed);
  return {
    seed,
    hue: 195 + r() * 15,        // sky blue .. azure (photos of peleides: cyan-leaning, never violet)
    light: 48 + r() * 8,
    black: 0.15 + r() * 0.25,   // 0 = all blue (menelaus) .. 1 = mostly black with a blue band (achilles)
    apexSpots: 2 + Math.floor(r() * 3),
    underHue: 22 + r() * 12,    // bronze-brown underside
    eyes: 0.8 + r() * 0.4,
    wear: r() * 0.6,            // 0 = fresh .. 1 = old, with rubbed-off scales and torn margins
  };
}

// ---------- painting ----------

const hsl = (h, s, l, a = 1) => `hsla(${h},${s}%,${l}%,${a})`;
const angleOf = (v) => Math.atan2(v.y, v.x);

// Sets up a canvas to draw in wing meters, clipped to the wing; returns the shared landmarks.
function begin(ctx, wing) {
  const S = TEX / BOX.size;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = 'none';
  ctx.clearRect(0, 0, TEX, TEX);
  // Canvas y points down and the texture is flipped, so y is negated.
  ctx.setTransform(S, 0, 0, -S, -BOX.x0 * S, TEX + BOX.y0 * S);
  const pts = wing.pts;
  const outline = new Path2D();
  pts.forEach((v, i) => (i ? outline.lineTo(v.x, v.y) : outline.moveTo(v.x, v.y)));
  outline.closePath();
  ctx.save();
  ctx.clip(outline);
  const blur = (m) => (ctx.filter = m ? `blur(${m * S}px)` : 'none');
  return { S, pts, length: wing.length, ends: wing.ends, veins: wing.veins, blur };
}

// Veins from the anatomy, tapering toward the margin, with a soft dark halo of scales.
function veins(ctx, L, color, alpha, width = 1) {
  const draw = (v, w0, w1, c = ctx) => {
    for (let i = 0; i < v.pts.length - 1; i++) {
      c.lineWidth = v.w * (w0 + (w1 - w0) * i / (v.pts.length - 1));
      c.beginPath();
      c.moveTo(v.pts[i].x, v.pts[i].y);
      c.lineTo(v.pts[i + 1].x, v.pts[i + 1].y);
      c.stroke();
    }
  };
  ctx.lineCap = 'round';
  // The halo is drawn sharp on a scratch layer and blurred once: a blur filter on each of the
  // hundreds of vein segments made painting take seconds.
  const layer = scratch(ctx);
  layer.lineCap = 'round';
  layer.strokeStyle = color(alpha * 0.35);
  L.veins.forEach((v) => draw(v, 0.0014 * width, 0.0008 * width, layer));
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = `blur(${0.0005 * L.S}px)`;
  ctx.drawImage(layer.canvas, 0, 0);
  ctx.restore();
  ctx.strokeStyle = color(alpha);
  L.veins.forEach((v) => draw(v, 0.00042 * width, 0.0002 * width));
}

// A cleared offscreen canvas with the same wing-space transform as ctx.
let scratchCtx;
function scratch(ctx) {
  scratchCtx ??= Object.assign(document.createElement('canvas'), { width: TEX, height: TEX }).getContext('2d');
  scratchCtx.setTransform(1, 0, 0, 1, 0, 0);
  scratchCtx.clearRect(0, 0, TEX, TEX);
  scratchCtx.setTransform(ctx.getTransform());
  return scratchCtx;
}

// Wear on the outer margin: patches where the scales have rubbed off, and nicks torn out of the
// edge. Seeded per wing, so the upper and under sides of the same wing agree.
function wearMarks(p, wing, isFore) {
  const seed = p.seed + (isFore ? 101 : 103), r = rng(seed);
  const outer = wing.pts.filter((v) => v.length() > wing.length * 0.55);
  const pick = () => outer[Math.floor(r() * outer.length)];
  return {
    seed,
    // Rubbed patches reach a few mm in from the edge, into the blue, where they show.
    bare: Array.from({ length: Math.round(2 + p.wear * 10) }, () => {
      const v = pick(), len = v.length();
      return [v.clone().multiplyScalar((len - r() * 0.007) / len), 0.0015 + r() * 0.004 * (0.5 + p.wear)];
    }),
    nicks: Array.from({ length: Math.round(p.wear * 6) }, () => [pick(), 0.0003 + r() * 0.0012]),
  };
}

// Bare membrane: dull and grey-brown, with no blue (the roughness mask then drops the lobe too).
function bare(ctx, L, marks, color) {
  for (const [v, rad] of marks.bare) {
    const g = ctx.createRadialGradient(v.x, v.y, 0, v.x, v.y, rad);
    g.addColorStop(0, color(0.8));
    g.addColorStop(1, color(0));
    ctx.fillStyle = g;
    ctx.fillRect(v.x - rad, v.y - rad, rad * 2, rad * 2);
  }
}

// Fringe: hair-scales ~1 mm long standing out past the outer margin, pale between the veins and
// dark where a vein ends (the chequered fringe in the photos). Drawn outside the clip, into the
// alpha, so the silhouette and the shadow are hairy.
function fringe(ctx, L, marks) {
  const r = rng(marks.seed + 7), pts = L.pts, n = pts.length;
  // Only the outer margin (between the first and last vein ends): the inner margins lie under
  // the other wing, and a pale comb there showed through.
  const ea = L.ends.map(angleOf), lo = Math.min(...ea) - 0.02, hi = Math.max(...ea) + 0.02;
  ctx.lineCap = 'round';
  ctx.lineWidth = 0.00009;
  for (let i = 0; i < n; i++) {
    const v = pts[i], next = pts[(i + 1) % n];
    if (v.length() < 0.55 * L.length || angleOf(v) < lo || angleOf(v) > hi) continue;
    const t = next.clone().sub(pts[(i + n - 1) % n]).normalize();
    const out = new THREE.Vector2(t.y, -t.x);
    if (out.dot(v) < 0) out.negate();
    for (let k = 0; k < 3; k++) {
      const p = v.clone().lerp(next, k / 3), a = angleOf(p);
      const dark = Math.min(...ea.map((e) => Math.abs(e - a))) < 0.05;
      const len = (dark ? 0.0007 : 0.001) * (0.7 + r() * 0.6), tilt = (r() - 0.5) * 0.5;
      const d = out.clone().rotateAround(new THREE.Vector2(), tilt);
      ctx.strokeStyle = dark ? hsl(25, 25, 9) : hsl(40, 10, 70 + r() * 12);
      ctx.beginPath();
      ctx.moveTo(p.x - d.x * 0.0002, p.y - d.y * 0.0002);
      ctx.lineTo(p.x + d.x * len, p.y + d.y * len);
      ctx.stroke();
    }
  }
  ctx.globalCompositeOperation = 'destination-out';
  for (const [v, rad] of marks.nicks) {
    ctx.beginPath();
    ctx.ellipse(v.x, v.y, rad, rad * (0.5 + r() * 0.5), r() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
}

// Ends the clip, adds the fringe and scale grain, and optionally writes a roughness map from the
// blue scales.
function finish(ctx, L, maskCtx, marks) {
  const fur = ctx.createRadialGradient(0, 0, 0, 0, 0, 0.01);
  fur.addColorStop(0, hsl(25, 15, 14, 0.95));
  fur.addColorStop(1, hsl(25, 15, 14, 0));
  ctx.fillStyle = fur;
  ctx.fillRect(BOX.x0, BOX.y0, BOX.size, BOX.size);
  ctx.restore();
  fringe(ctx, L, marks);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = 'none';
  const img = ctx.getImageData(0, 0, TEX, TEX), d = img.data;
  const mask = maskCtx && maskCtx.createImageData(TEX, TEX);
  const rootX = -BOX.x0 * L.S, rootY = TEX + BOX.y0 * L.S;
  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      const i = (y * TEX + x) * 4;
      if (!d[i + 3]) continue;
      const a = Math.atan2(y - rootY, x - rootX), dist = Math.hypot(y - rootY, x - rootX);
      // Scales sit in rows radiating from the root.
      const k = 1 + (Math.random() - 0.5) * 0.12 + Math.sin(a * 700) * 0.025 + Math.sin(dist * 1.9) * 0.02;
      d[i] *= k; d[i + 1] *= k; d[i + 2] *= k;
      if (mask) {
        const m = THREE.MathUtils.smoothstep(d[i + 2] - d[i], 30, 110) * 255;
        // Roughness (green channel): blue scales semi-glossy, brown scales velvety matte.
        mask.data[i] = mask.data[i + 1] = mask.data[i + 2] = 235 - m * 0.6;
        mask.data[i + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  if (mask) maskCtx.putImageData(mask, 0, 0);
}

// Upperside, after M. peleides photos: blue that glows pale cyan in the middle of each wing and
// deepens to ultramarine toward the root, inside a soft-edged chocolate border.
export function drawUpper(ctx, maskCtx, wing, p, isFore) {
  const r = rng(p.seed + (isFore ? 0 : 7));
  const L = begin(ctx, wing);

  ctx.fillStyle = hsl(p.hue + 10, 85, p.light * 0.5);
  ctx.fillRect(BOX.x0, BOX.y0, BOX.size, BOX.size);
  const [gx, gy] = isFore ? [0.027, 0.011] : [0.024, -0.022];
  const glow = ctx.createRadialGradient(gx, gy, 0, gx, gy, 0.026);
  glow.addColorStop(0, hsl(p.hue - 4, 90, Math.min(68, p.light + 12)));
  glow.addColorStop(0.45, hsl(p.hue, 95, p.light));
  glow.addColorStop(1, hsl(p.hue + 10, 90, p.light * 0.6, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(BOX.x0, BOX.y0, BOX.size, BOX.size);
  L.blur(0.002);
  for (let i = 0; i < 12; i++) {
    ctx.fillStyle = hsl(p.hue + (r() - 0.5) * 14, 90, p.light * (0.8 + r() * 0.35), 0.2);
    ctx.beginPath();
    ctx.arc(r() * 0.045, (r() - 0.6) * 0.06, 0.003 + r() * 0.006, 0, Math.PI * 2);
    ctx.fill();
  }
  // Dark root, and the hindwing's hairy brown-grey inner margin.
  const root = ctx.createRadialGradient(0, 0, 0, 0, 0, 0.013);
  root.addColorStop(0, hsl(25, 20, 10, 0.95));
  root.addColorStop(1, hsl(25, 20, 10, 0));
  ctx.fillStyle = root;
  ctx.fillRect(BOX.x0, BOX.y0, BOX.size, BOX.size);
  if (!isFore) {
    ctx.fillStyle = hsl(28, 15, 22, 0.9);
    ctx.beginPath();
    ctx.ellipse(0.003, -0.026, 0.006, 0.021, 0.12, 0, Math.PI * 2);
    ctx.fill();
  }
  L.blur(0);

  // Chocolate border: thin along the forewing's leading edge, broad at the apex, a band elsewhere.
  const ink = hsl(22, 35, 8);
  const w = 0.003 + p.black * 0.011;
  ctx.fillStyle = ink;
  ctx.strokeStyle = ink;
  L.blur(0.0007);
  if (isFore) {
    const costa = L.pts.filter((v) => v.y > 0.003 && v.x < 0.044);
    ctx.lineWidth = 0.0035;
    ctx.beginPath();
    costa.forEach((v, i) => (i ? ctx.lineTo(v.x, v.y) : ctx.moveTo(v.x, v.y)));
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(0.045, 0.021, 0.006 + w, 0.004 + w * 0.6, 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
  const band = new Path2D();
  L.pts.forEach((v, i) => (i ? band.lineTo(v.x, v.y) : band.moveTo(v.x, v.y)));
  band.closePath();
  const inner = L.pts.map((v) => {
    const a = angleOf(v), len = v.length();
    if (len < 0.02) return v.clone(); // no margin band near the root
    const nearest = Math.min(...L.ends.map((e) => Math.abs(angleOf(e) - a)));
    const k = Math.max(0, (len - w * (0.8 + 0.5 * Math.min(1, nearest / 0.1))) / len);
    return v.clone().multiplyScalar(k);
  });
  inner.reverse().forEach((v, i) => (i ? band.lineTo(v.x, v.y) : band.moveTo(v.x, v.y)));
  band.closePath();
  L.blur(0.0012);
  ctx.fill(band, 'evenodd');
  L.blur(0);

  // Spots in the border: white on the forewing (a bold inner row near the apex, a fine outer row),
  // tan lunules plus a few white dots on the hindwing.
  const spotAt = (i, inset, rx, ry, color) => {
    const mid = L.ends[i].clone().add(L.ends[i + 1]).multiplyScalar(0.5);
    const k = (mid.length() - w * inset) / mid.length();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(mid.x * k, mid.y * k, rx, ry, angleOf(mid), 0, Math.PI * 2);
    ctx.fill();
  };
  for (let i = 0; i < L.ends.length - 1; i++) {
    if (isFore) {
      if (i < p.apexSpots) spotAt(i, 0.75, 0.0007 + r() * 0.0004, 0.001, hsl(200, 15, 93, 0.95));
      spotAt(i, 0.3, 0.0003 + r() * 0.0001, 0.0005, hsl(200, 15, 90, 0.85));
    } else {
      // Photos: faint brown rings in the hindwing border, and a small white dot (often a pair)
      // in every cell near the edge.
      spotAt(i, 0.55, 0.0004, 0.0011, hsl(25, 30, 24, 0.6));
      spotAt(i, 0.22, 0.00028, 0.0004, hsl(200, 15, 90, 0.85));
    }
  }

  const marks = wearMarks(p, wing, isFore);
  L.blur(0.0004);
  bare(ctx, L, marks, (a) => hsl(28, 10, 20, a));
  L.blur(0);
  // In the photos the veins on the blue are fine and only a little darker than the blue.
  veins(ctx, L, (a) => hsl(p.hue + 10, 70, 14, a), 0.7, 0.7);
  finish(ctx, L, maskCtx, marks);
}

// Underside, after M. peleides photos: mottled brown with cream zigzag bands, wavy submarginal
// lines, and a row of eyespots parallel to the margin (3 on the forewing, 4 on the hindwing).
export function drawUnder(ctx, wing, p, isFore) {
  const r = rng(p.seed + (isFore ? 13 : 29));
  const L = begin(ctx, wing);
  const h = p.underHue;

  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 0.045);
  g.addColorStop(0, hsl(h, 30, 16));
  g.addColorStop(0.5, hsl(h, 38, 27));
  g.addColorStop(1, hsl(h + 4, 34, 22));
  ctx.fillStyle = g;
  ctx.fillRect(BOX.x0, BOX.y0, BOX.size, BOX.size);

  // Fine mottling: many short, faint strokes running across the wing.
  ctx.lineCap = 'round';
  for (let i = 0; i < 900; i++) {
    const x = r() * 0.05, y = (r() - 0.62) * 0.075, a = Math.atan2(y, x) + Math.PI / 2 + (r() - 0.5) * 0.6;
    const len = 0.0008 + r() * 0.0015;
    ctx.strokeStyle = r() < 0.5 ? hsl(h, 30, 15, 0.18) : hsl(h + 10, 30, 55, 0.14);
    ctx.lineWidth = 0.0002 + r() * 0.0002;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }

  // Cream zigzag bands across the basal and median areas.
  const zigzag = (rad, amp, color, width) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (let i = 0; i <= 120; i++) {
      const a = (isFore ? -0.45 : -1.65) + i / 120 * (isFore ? 1.4 : 1.55);
      const rr = rad + amp * (i % 2 ? 1 : -1) * (0.6 + r() * 0.4);
      (i ? ctx.lineTo : ctx.moveTo).call(ctx, Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.stroke();
  };
  L.blur(0.00015);
  // A pale tan median band, edged by cream and dark zigzags.
  L.blur(0.0015);
  zigzag(0.0145, 0.0004, hsl(h + 8, 35, 42, 0.55), 0.005);
  L.blur(0.00015);
  zigzag(0.009, 0.0007, hsl(42, 50, 78, 0.95), 0.0011);
  zigzag(0.0175, 0.001, hsl(42, 45, 74, 0.85), 0.0009);
  zigzag(0.0188, 0.001, hsl(h, 40, 10, 0.75), 0.0007);
  if (isFore) {
    ctx.fillStyle = hsl(42, 45, 76, 0.85);
    ctx.beginPath();
    ctx.ellipse(0.022, 0.017, 0.004, 0.0011, 0.55, 0, Math.PI * 2);
    ctx.fill();
  }

  // Two wavy lines just inside the margin, dark then pale.
  const inset = (d, wave) => L.pts.filter((v) => v.length() > 0.024).map((v) => {
    const len = v.length(), k = (len - d - wave * Math.sin(angleOf(v) * 90)) / len;
    return v.clone().multiplyScalar(k);
  });
  for (const [d, c] of [[0.0032, hsl(h, 35, 12, 0.75)], [0.0019, hsl(40, 35, 70, 0.6)]]) {
    ctx.strokeStyle = c;
    ctx.lineWidth = 0.0006;
    ctx.beginPath();
    inset(d, 0.0004).forEach((v, i) => (i ? ctx.lineTo(v.x, v.y) : ctx.moveTo(v.x, v.y)));
    ctx.stroke();
  }
  L.blur(0);

  // Eyespots: thin yellow ring, dark ring, reddish-brown iris, small off-centre white pupil.
  // Cells between margin veins: forewing M1–M2, M3–CuA1, CuA2–A; hindwing with the big one in M2–M3.
  const cells = isFore ? [2, 4, 6] : [0, 2, 3, 4];
  cells.forEach((j, i) => {
    const e = L.ends[j].clone().add(L.ends[j + 1]).multiplyScalar(0.5);
    const k = (e.length() - 0.0085) / e.length();
    const big = !isFore && i === 1 ? 1.6 : 1;
    const s = p.eyes * big * (isFore ? 0.75 : 0.85) * (0.85 + r() * 0.3);
    const cx = e.x * k, cy = e.y * k;
    [[0.0032, hsl(h, 40, 12)], [0.00285, hsl(45, 80, 64)], [0.0025, hsl(h - 5, 45, 9)], [0.002, hsl(8, 50, 28)], [0.0011, hsl(10, 55, 18)]].forEach(([rad, c]) => {
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rad * s, rad * s * 1.1, angleOf(e), 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.fillStyle = hsl(0, 0, 95);
    ctx.beginPath();
    ctx.arc(cx + 0.0004 * s, cy + 0.0004 * s, 0.00035 * s, 0, Math.PI * 2);
    ctx.fill();
  });

  const marks = wearMarks(p, wing, isFore);
  L.blur(0.0004);
  bare(ctx, L, marks, (a) => hsl(h + 6, 14, 36, a));
  L.blur(0);
  veins(ctx, L, (a) => hsl(h, 30, 12, a), 0.5);
  finish(ctx, L, null, marks);
}
