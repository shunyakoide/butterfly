import * as THREE from 'three/webgpu';

// Wing anatomy of Morpho peleides: outline, venation and surface relief.
// Wing coordinates are meters in the right-hand wing's plane: +x outward, +y forward, root at 0.

// Texture space: a square box over both wings, so patterns are drawn in wing coordinates.
export const BOX = { x0: -0.011, y0: -0.047, size: 0.076 };
export const TEX = 1024;

const deg = THREE.MathUtils.degToRad;
const { smoothstep } = THREE.MathUtils;

// Specs are in normalised coordinates after Comstock–Needham nymphalid diagrams:
// u runs along the costa from root (0) to apex (1), v toward the trailing edge.
// Veins ending on the outer margin are listed in `margin`, from the costa side backwards.
// shortcut: schematic venation, not digitised from a specimen; trace a photo if it needs to be exact.
const FORE_SPEC = {
  // width: chordwise stretch. Understory Morpho (helenor/peleides) have a short, rounded forewing
  // (Chazot 2016, doi:10.1111/evo.12842) with a forewing aspect ratio near the low end of the
  // genus' ~5–7 (Le Roy 2021); in top-down photos the outer margin is about as long as the
  // forewing. 1.25 gives AR ≈ 5 (it was 6.2, too slender).
  length: 0.052, angle: deg(26), scallop: 0.006, width: 1.25,
  outline: [[0, 0], [0.25, -0.015], [0.5, -0.02], [0.78, -0.012], [1, 0], [0.93, 0.14], [0.84, 0.28],
    [0.73, 0.41], [0.62, 0.52], [0.31, 0.32], [0.1, 0.15], [0, 0.08]],
  veins: [
    ['Sc', [[0, 0.02], [0.58, 0]], 1.5],
    ['cellUpper', [[0.02, 0.03], [0.5, 0.13]], 1.2],
    ['cellLower', [[0.03, 0.06], [0.42, 0.3]], 1.2],
    ['cellEnd', [[0.5, 0.13], [0.44, 0.2], [0.42, 0.3]], 0.6],
    ['R1', [[0.38, 0.1], [0.68, 0.01]], 0.8],
    ['R2', [[0.47, 0.12], [0.78, 0.01]], 0.8],
    ['R3', [[0.5, 0.13], [0.66, 0.1], [0.88, 0.01]], 0.8],
    ['R4', [[0.66, 0.1], [0.8, 0.07], [1, 0]], 0.8],
    ['R5', [[0.8, 0.07], [0.98, 0.04]], 0.7],
    ['M1', [[0.51, 0.15], [0.95, 0.1]], 0.9],
    ['M2', [[0.47, 0.21], [0.89, 0.2]], 0.9],
    ['M3', [[0.42, 0.3], [0.82, 0.3]], 0.9],
    ['CuA1', [[0.36, 0.32], [0.76, 0.38]], 1],
    ['CuA2', [[0.24, 0.33], [0.69, 0.46]], 1],
    ['A', [[0.03, 0.08], [0.62, 0.52]], 1.2],
  ],
  margin: ['R4', 'R5', 'M1', 'M2', 'M3', 'CuA1', 'CuA2', 'A'],
};
// The hindwing discal cell is open in every Morpho (no vein closes it).
const HIND_SPEC = {
  // "Narrow elongated hindwing" in understory species (Chazot 2016).
  length: 0.047, angle: deg(-8), scallop: 0.028, width: 0.9,
  outline: [[0, 0], [0.2, -0.04], [0.45, -0.06], [0.65, -0.03], [0.78, 0.02], [0.88, 0.17], [0.92, 0.35],
    [0.88, 0.53], [0.8, 0.7], [0.68, 0.83], [0.55, 0.92], [0.35, 0.8], [0.15, 0.6], [0.05, 0.3], [0, 0.05]],
  veins: [
    ['humeral', [[0.05, 0], [0.1, -0.06]], 0.8],
    ['ScR1', [[0.02, 0.01], [0.4, -0.04], [0.76, 0.02]], 1.4],
    ['cellUpper', [[0.03, 0.03], [0.45, 0.15]], 1.2],
    ['cellLower', [[0.04, 0.06], [0.4, 0.32]], 1.2],
    ['Rs', [[0.45, 0.15], [0.88, 0.18]], 0.9],
    ['M1', [[0.47, 0.19], [0.93, 0.32]], 0.9],
    ['M2', [[0.44, 0.24], [0.9, 0.48]], 0.9],
    ['M3', [[0.4, 0.32], [0.84, 0.64]], 0.9],
    ['CuA1', [[0.34, 0.34], [0.72, 0.78]], 1],
    ['CuA2', [[0.24, 0.36], [0.58, 0.88]], 1],
    ['A12', [[0.04, 0.08], [0.48, 0.9]], 1.1],
    ['A3', [[0.03, 0.08], [0.2, 0.55]], 0.8],
  ],
  margin: ['Rs', 'M1', 'M2', 'M3', 'CuA1', 'CuA2', 'A12'],
};

function distToPolyline(p, pts) {
  let best = Infinity, along = 0, run = 0, total = 0;
  for (let i = 0; i < pts.length - 1; i++) total += pts[i].distanceTo(pts[i + 1]);
  const ab = new THREE.Vector2(), ap = new THREE.Vector2();
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    ab.subVectors(b, a);
    const len2 = ab.lengthSq();
    const t = len2 ? THREE.MathUtils.clamp(ap.subVectors(p, a).dot(ab) / len2, 0, 1) : 0;
    const d = Math.hypot(a.x + ab.x * t - p.x, a.y + ab.y * t - p.y);
    if (d < best) { best = d; along = (run + Math.sqrt(len2) * t) / total; }
    run += Math.sqrt(len2);
  }
  return [best, along];
}

function build(spec) {
  const c = new THREE.Vector2(Math.cos(spec.angle), Math.sin(spec.angle));
  const t = new THREE.Vector2(Math.sin(spec.angle), -Math.cos(spec.angle));
  const P = ([u, v]) => c.clone().multiplyScalar(u * spec.length).addScaledVector(t, v * spec.width * spec.length);

  const veins = spec.veins.map(([name, uv, w]) => {
    // Two-point veins get a gentle bow, as real veins curve.
    const pts = uv.length === 2 ? [uv[0], [(uv[0][0] + uv[1][0]) / 2, (uv[0][1] + uv[1][1]) / 2 + 0.012], uv[1]] : uv;
    return { name, w, pts: new THREE.SplineCurve(pts.map(P)).getPoints(24) };
  });
  const byName = Object.fromEntries(veins.map((v) => [v.name, v]));
  const ends = spec.margin.map((n) => byName[n].pts.at(-1));
  // Corrugation: margin veins alternate between ridges and valleys; the costa is a thick ridge.
  spec.margin.forEach((n, i) => (byName[n].pleat = i % 2 ? -1 : 1));
  for (const v of veins) v.pleat ??= v.w > 1.3 ? 1.6 : 0.5;

  const shape = new THREE.Shape();
  shape.moveTo(...P(spec.outline[0]).toArray());
  shape.splineThru(spec.outline.slice(1).concat([spec.outline[0]]).map(P));
  // Margin lobes at each vein end, dipping in between.
  const pts = shape.getSpacedPoints(400).slice(0, -1).map((v) => {
    const dists = ends.map((e) => e.distanceTo(v));
    const near = Math.min(...dists);
    if (near > 0.012) return v;
    const lobe = Math.exp(-((near / 0.0032) ** 2));
    return v.multiplyScalar(1 - spec.scallop * (1 - lobe) * (1 - smoothstep(near, 0.006, 0.012)));
  });
  return { length: spec.length, pts, shape: new THREE.Shape(pts), veins, ends };
}

export const FORE = build(FORE_SPEC);
export const HIND = build(HIND_SPEC);

function inside(p, poly) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

// Surface height (meters, +z dorsal): a gentle camber plus ridges and valleys along the veins.
function relief(p, wing, isInside) {
  const edge = isInside ? Math.min(...wing.pts.map((q) => q.distanceTo(p))) : 0;
  let z = 0.0016 * smoothstep(edge, 0, 0.013);
  for (const v of wing.veins) {
    const [d, along] = distToPolyline(p, v.pts);
    z += v.pleat * 0.00028 * Math.exp(-((d / 0.0018) ** 2)) * (1 - 0.7 * along);
  }
  return z;
}

// A regular grid over the wing's bounds, so it can bend smoothly. The outline is cut by the
// colour texture's alpha (alphaTest / alphaToCoverage), which keeps the edge pixel-exact.
// (Earcut with Steiner points made sliver triangles that banded across the wing.)
export function wingGeometry(wing) {
  const step = 0.001;
  const box = new THREE.Box2().setFromPoints(wing.pts).expandByScalar(0.0015);
  const size = box.getSize(new THREE.Vector2()), centre = box.getCenter(new THREE.Vector2());
  const geo = new THREE.PlaneGeometry(size.x, size.y, Math.ceil(size.x / step), Math.ceil(size.y / step));
  geo.translate(centre.x, centre.y, 0);
  const pos = geo.attributes.position, uv = geo.attributes.uv, p = new THREE.Vector2();
  for (let i = 0; i < pos.count; i++) {
    p.set(pos.getX(i), pos.getY(i));
    pos.setZ(i, relief(p, wing, inside(p, wing.pts)));
    uv.setXY(i, (p.x - BOX.x0) / BOX.size, (p.y - BOX.y0) / BOX.size);
  }
  geo.computeVertexNormals();
  geo.computeTangents();
  return geo;
}

// Fine relief as a tangent-space normal map: raised veins (tapering toward the margin) and
// scale grain. `veinHeight` scales the veins: they read faintly through the dorsal scales and
// stand out more underneath.
export function reliefNormalMap(wing, veinHeight) {
  const S = TEX / BOX.size;
  const c = document.createElement('canvas');
  c.width = c.height = TEX;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, TEX, TEX);
  ctx.setTransform(S, 0, 0, -S, -BOX.x0 * S, TEX + BOX.y0 * S);
  ctx.strokeStyle = '#fff';
  ctx.lineCap = 'round';
  for (const v of wing.veins) {
    for (let i = 0; i < v.pts.length - 1; i++) {
      ctx.lineWidth = v.w * (0.00042 - 0.00026 * i / v.pts.length);
      ctx.beginPath();
      ctx.moveTo(v.pts[i].x, v.pts[i].y);
      ctx.lineTo(v.pts[i + 1].x, v.pts[i + 1].y);
      ctx.stroke();
    }
  }
  // Soften once afterwards (a filter on every stroke is very slow).
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = `blur(${0.00012 * S}px)`;
  ctx.drawImage(c, 0, 0);
  const h = ctx.getImageData(0, 0, TEX, TEX).data;
  const H = (x, y) => h[(Math.min(TEX - 1, Math.max(0, y)) * TEX + Math.min(TEX - 1, Math.max(0, x))) * 4] / 255;
  const out = new Uint8Array(TEX * TEX * 4);
  // One texel is ~74 µm; veins rise ~30 µm, so a full step is a slope of about 0.4.
  const k = 0.4 * veinHeight;
  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      const grain = 0.06;
      const dx = (H(x + 1, y) - H(x - 1, y)) * k + (Math.random() - 0.5) * grain;
      const dy = (H(x, y - 1) - H(x, y + 1)) * k + (Math.random() - 0.5) * grain;
      // DataTexture rows start at v = 0 (the canvas bottom), unlike flipped canvas textures.
      const l = Math.hypot(dx, dy, 1), i = ((TEX - 1 - y) * TEX + x) * 4;
      out[i] = (-dx / l * 0.5 + 0.5) * 255;
      out[i + 1] = (-dy / l * 0.5 + 0.5) * 255;
      out[i + 2] = (1 / l * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(out, TEX, TEX);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}
