import * as THREE from 'three/webgpu';
import { attribute, float, vec3, vec4, sin, time, fract, dot, mix, mrt, positionGeometry, modelWorldMatrix, modelWorldMatrixInverse, cameraPosition } from 'three/tsl';
import { TEX } from './wing.js';

// The butterfly as a 3D scan's point cloud coming apart (the FX overlay "cloud"): its solid meshes
// are hidden and points scattered over the same surfaces are drawn instead, in the wings' painted
// colours, upper or under side by which way each wing faces the camera. The wings' outer band is
// thinned so the edge looks frayed, and from spots on the edge threads of points stream away on the
// wind, fading as they go. The points write the butterfly mask, so fx.js can black out everything else.

const WING_POINTS = 45000; // per wing (est.: dense enough to read the pattern, sparse enough to see through)
const BODY_POINTS = 9000;
const RATE = 0.12;         // per s: how often a thread's point sets off again
const RUN = 0.1;           // m a point travels downwind before it is gone
const THREADS = 16;        // per wing
const THREAD_POINTS = 1500;
const THREAD_WIDTH = 0.00006; // m: a thread's half-width where it leaves the wing (it widens 4x downwind)
const CURL = 0.02;         // m a thread swings off the wind's line at its far end (a slow wave, like hair in wind)
const GAIN = 3;            // the painted colours are darker than the lit wing (its blue is structural); est., by eye
// Toward the left of the frame, along the wall: off the wall toward the lens the threads leave the
// focal plane and the depth of field blurs them into haze.
const WIND = new THREE.Vector3(-1, 0.3, 0.04).normalize();

// Points spread evenly over a mesh's triangles: their positions in its frame, and colourAt(i, a, b, c,
// u, v) for each (the triangle's vertex indices and barycentric weights), or null to drop the point.
function sampleSurface(geo, n, colourAt) {
  const pos = geo.attributes.position, idx = geo.index;
  const tris = (idx ? idx.count : pos.count) / 3, vert = (k) => (idx ? idx.getX(k) : k);
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  const cum = new Float64Array(tris);
  let total = 0;
  for (let t = 0; t < tris; t++) {
    A.fromBufferAttribute(pos, vert(3 * t)); B.fromBufferAttribute(pos, vert(3 * t + 1)); C.fromBufferAttribute(pos, vert(3 * t + 2));
    total += B.sub(A).cross(C.sub(A)).length() / 2;
    cum[t] = total;
  }
  const out = { position: [], colour: [] };
  for (let tries = 0; out.position.length < n * 3 && tries < n * 4; tries++) {
    const r = Math.random() * total;
    let lo = 0, hi = tris - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < r) lo = mid + 1; else hi = mid; }
    let u = Math.random(), v = Math.random();
    if (u + v > 1) [u, v] = [1 - u, 1 - v];
    const [a, b, c] = [vert(3 * lo), vert(3 * lo + 1), vert(3 * lo + 2)];
    const col = colourAt(a, b, c, u, v);
    if (!col) continue;
    A.fromBufferAttribute(pos, a); B.fromBufferAttribute(pos, b); C.fromBufferAttribute(pos, c);
    const p = A.multiplyScalar(1 - u - v).addScaledVector(B, u).addScaledVector(C, v);
    out.position.push(p.x, p.y, p.z);
    out.colour.push(...col);
  }
  return out;
}

// The colour of a painted wing texture at the point's uv: linear rgb, or null outside the outline.
function textureColour(geo, canvas) {
  const data = canvas.getContext('2d').getImageData(0, 0, TEX, TEX).data, uv = geo.attributes.uv, c = new THREE.Color();
  return (a, b, cc, u, v) => {
    const s = uv.getX(a) * (1 - u - v) + uv.getX(b) * u + uv.getX(cc) * v;
    const t = uv.getY(a) * (1 - u - v) + uv.getY(b) * u + uv.getY(cc) * v;
    const k = 4 * (Math.min(TEX - 1, Math.floor((1 - t) * TEX)) * TEX + Math.min(TEX - 1, Math.floor(s * TEX)));
    if (data[k + 3] < 128) return null;
    c.setRGB(data[k] / 255, data[k + 1] / 255, data[k + 2] / 255, THREE.SRGBColorSpace);
    return [c.r, c.g, c.b];
  };
}

export function buildCloud(bf) {
  const maskOut = mrt({ mask: float(1) });
  function cloudOf(mesh, attrs, material) {
    const geo = new THREE.BufferGeometry();
    for (const [name, [data, size]] of Object.entries(attrs)) geo.setAttribute(name, new THREE.Float32BufferAttribute(data, size));
    material.mrtNode = maskOut;
    const p = new THREE.Points(geo, material);
    p.frustumCulled = false;
    p.visible = false;
    mesh.add(p);
    return p;
  }

  // Still points on a surface, in its colours; on a wing (under given), the colours of the side facing the camera.
  function surface(mesh, data) {
    const m = new THREE.PointsNodeMaterial();
    let colour = attribute('colour', 'vec3');
    if (data.under) {
      // The wing's upper side is +z in its frame.
      const facing = dot(modelWorldMatrix.mul(vec4(0, 0, 1, 0)).xyz, cameraPosition.sub(modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz));
      colour = facing.greaterThan(0).select(colour, attribute('under', 'vec3'));
    }
    m.colorNode = colour.mul(GAIN);
    return cloudOf(mesh, { position: [data.position, 3], colour: [data.colour, 3], ...(data.under && { under: [data.under, 3] }) }, m);
  }

  // Threads: from a few spots on a wing's outer edge, points stream off on the wind, each thread
  // curling its own way (the same curl for all its points, so they string out along one path),
  // widening and fading as it goes, and starting again.
  function threads(mesh, sources) {
    const position = [], colour = [], seed = [];
    sources.forEach((s, k) => {
      for (let i = 0; i < THREAD_POINTS; i++) { position.push(...s.p); colour.push(...s.colour); seed.push(Math.random(), (k * 0.618) % 1); }
    });
    const m = new THREE.PointsNodeMaterial();
    const sd = attribute('seed', 'vec2'), a = fract(time.mul(RATE).add(sd.x)), ph = sd.y.mul(6.283);
    // Little toward the lens, as for the wind.
    const curl = vec3(sin(a.mul(2.5).add(ph)).mul(0.5), sin(a.mul(3).add(ph.mul(1.3))).add(sin(a.mul(9).add(ph.mul(2))).mul(0.15)), sin(a.mul(2).add(ph.mul(0.7))).mul(0.15)).mul(CURL);
    const spread = vec3(sin(sd.x.mul(917)), sin(sd.x.mul(571)), 0).mul(a.mul(3).add(1).mul(THREAD_WIDTH));
    const world = vec3(...WIND.toArray()).mul(a.mul(RUN)).add(curl.mul(a)).add(spread);
    m.positionNode = positionGeometry.add(modelWorldMatrixInverse.mul(vec4(world, 0)).xyz);
    // The edge is mostly the black border, so a thread takes on the wing's blue, or it would not show.
    m.colorNode = mix(attribute('colour', 'vec3'), vec3(0.06, 0.22, 0.6), 0.6).mul(a.oneMinus().pow(1.5)).mul(GAIN);
    return cloudOf(mesh, { position: [position, 3], colour: [colour, 3], seed: [seed, 2] }, m);
  }

  bf.group.updateMatrixWorld(true);
  const solid = [];
  bf.group.traverse((o) => { if (o.isMesh) solid.push(o); });
  const clouds = [];
  // Wings: points on the upper-side mesh, with both sides' colours; the outer band thinned so the
  // edge looks frayed, and threads from the outermost points.
  for (const pivot of bf.pivots) {
    const k = pivot.userData.hind ? 1 : 0, mesh = pivot.children[0], geo = mesh.geometry;
    const upper = textureColour(geo, bf.upper[k].image), under = textureColour(geo, bf.under[k].image);
    const both = (a, b, c, u, v) => { const t = upper(a, b, c, u, v), s = under(a, b, c, u, v); return t && s ? [...t, ...s] : null; };
    const raw = sampleSurface(geo, WING_POINTS, both);
    const n = raw.position.length / 3, r = (i) => Math.hypot(raw.position[3 * i], raw.position[3 * i + 1]);
    const reach = Math.max(...Array.from({ length: n }, (_, i) => r(i)));
    const data = { position: [], colour: [], under: [] }, edge = [];
    for (let i = 0; i < n; i++) {
      const f = r(i) / reach;
      if (f > 0.9) edge.push(i);
      if (Math.random() < 0.6 * THREE.MathUtils.smoothstep(f, 0.75, 1)) continue;
      data.position.push(...raw.position.slice(3 * i, 3 * i + 3));
      data.colour.push(...raw.colour.slice(6 * i, 6 * i + 3));
      data.under.push(...raw.colour.slice(6 * i + 3, 6 * i + 6));
    }
    clouds.push(surface(mesh, data));
    const sources = Array.from({ length: THREADS }, () => {
      const i = edge[Math.floor(Math.random() * edge.length)];
      return { p: raw.position.slice(3 * i, 3 * i + 3), colour: raw.colour.slice(6 * i, 6 * i + 3) };
    });
    clouds.push(threads(mesh, sources));
  }
  // Body: the plain meshes (not the legs, which bend, or the instanced hairs and joints), by area, in
  // their own colours brightened (the cuticle is nearly black and would vanish against black).
  const parts = solid.filter((o) => !o.isSkinnedMesh && !o.isInstancedMesh && !bf.pivots.includes(o.parent));
  const area = parts.map((o) => {
    const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry, p = g.attributes.position, s = new THREE.Vector3().setFromMatrixScale(o.matrixWorld);
    let a = 0;
    const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
    for (let i = 0; i < p.count; i += 3) {
      A.fromBufferAttribute(p, i).multiply(s); B.fromBufferAttribute(p, i + 1).multiply(s); C.fromBufferAttribute(p, i + 2).multiply(s);
      a += B.sub(A).cross(C.sub(A)).length() / 2;
    }
    return a;
  });
  const total = area.reduce((s, a) => s + a, 0);
  parts.forEach((o, i) => {
    const base = o.material.color ?? new THREE.Color(0x2a1d14), vc = o.geometry.attributes.color;
    const colourAt = (a, b, c, u, v) => {
      const col = vc ? new THREE.Color().fromBufferAttribute(vc, a).multiplyScalar(1 - u - v)
        .add(new THREE.Color().fromBufferAttribute(vc, b).multiplyScalar(u)).add(new THREE.Color().fromBufferAttribute(vc, c).multiplyScalar(v)) : base.clone();
      return col.multiplyScalar(3 * (0.6 + 0.8 * Math.random())).toArray();
    };
    clouds.push(surface(o, sampleSurface(o.geometry, Math.round(BODY_POINTS * area[i] / total), colourAt)));
  });

  // The solid butterfly's materials (shared between meshes), hidden by their visible flag so the
  // meshes, which carry the points, stay in the scene.
  const materials = [...new Set(solid.map((o) => o.material))];
  // on: points instead of the solid butterfly.
  function show(on) {
    for (const m of materials) m.visible = !on;
    for (const c of clouds) c.visible = on;
  }
  return { show };
}
