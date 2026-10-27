import * as THREE from 'three/webgpu';
import { fbm, rng } from './noise.js';

// The body of M. peleides, in model meters (the butterfly is drawn at 1/1.3 size).
// Local frame: +x right, +y forward (head), +z dorsal; the thorax centre is the origin.
// After close-up photos (refs: Unsplash photo-1760003553872): a glossy navy-black compound eye in
// a ring of pale scales; long upturned palps, pinkish red outside and white inside; a coiled
// proboscis; long slender antennae thickening gradually into a club; the thorax under dark brown
// hair, with red and cream tufts underneath; slender silvery-grey legs with dark spines.

const deg = THREE.MathUtils.degToRad;
export const LEG_DROP = 0.004; // legs reach this far below the body centre

const hsl = (h, s, l) => new THREE.Color().setHSL(h / 360, s / 100, l / 100);

// A tube along a smooth curve with radius r(t) and colour c(t, around) — legs, palps, antennae.
function taperTube(points, radius, color, { seg = 32, radial = 8 } = {}) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
  const { tangents, normals, binormals } = curve.computeFrenetFrames(seg, false);
  const pos = [], col = [], idx = [];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg, p = curve.getPointAt(t), r = radius(t);
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const n = normals[i].clone().multiplyScalar(Math.cos(a)).addScaledVector(binormals[i], Math.sin(a));
      pos.push(p.x + n.x * r, p.y + n.y * r, p.z + n.z * r);
      const c = color(t, n);
      col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j, b = a + radial + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.userData.curve = curve;
  return g;
}

// Hairs: one instanced thin cone per hair. place() returns { p, dir, len, width, color } or null.
const HAIR = new THREE.ConeGeometry(1, 1, 3, 1, true).translate(0, 0.5, 0);
function hairs(count, place, material) {
  const mesh = new THREE.InstancedMesh(HAIR, material, count);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  let n = 0;
  for (let i = 0; i < count; i++) {
    const h = place(i);
    if (!h) continue;
    q.setFromUnitVectors(up, h.dir.normalize());
    m.compose(h.p, q, new THREE.Vector3(h.width, h.len, h.width));
    mesh.setMatrixAt(n, m);
    mesh.setColorAt(n, h.color);
    n++;
  }
  mesh.count = n;
  return mesh;
}

// Hexagonal ommatidia as a tiling normal map (each facet a slight dome).
function ommatidiaNormals(size = 128) {
  const data = new Uint8Array(size * size * 4);
  const cell = size / 8;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Nearest centre on a hex lattice that tiles the texture.
      let best = 1e9, dx = 0, dy = 0;
      // 8 columns x 10 rows (slightly squashed hexagons) so the pattern tiles.
      for (let j = -1; j <= 11; j++) {
        for (let i = -1; i <= 9; i++) {
          const cx = i * cell + (((j % 2) + 2) % 2 ? cell / 2 : 0), cy = j * size / 10;
          const ex = x - cx, ey = y - cy, d = ex * ex + ey * ey;
          if (d < best) { best = d; dx = ex; dy = ey; }
        }
      }
      const r = cell * 0.55, k = 1.6;
      const nx = (-dx / r) * k * 0.5, ny = (-dy / r) * k * 0.5;
      const l = Math.hypot(nx, ny, 1), o = (y * size + x) * 4;
      data[o] = (nx / l * 0.5 + 0.5) * 255; data[o + 1] = (ny / l * 0.5 + 0.5) * 255;
      data[o + 2] = (1 / l * 0.5 + 0.5) * 255; data[o + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, size, size);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  // Facets up to 34 µm across in M. peleides (Frederiksen & Warrant 2008). The eye (r 1.5 mm
  // here, ~1.95 mm at full SCALE) is ~360 facets round and ~210 rows pole to pole.
  t.repeat.set(45, 21);
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

export function buildBody() {
  const r = rng(7);
  const g = new THREE.Group();
  const cuticle = new THREE.MeshPhysicalMaterial({ color: 0x17110c, roughness: 0.6, clearcoat: 0.3 });
  const tubeMat = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.55, sheen: 0.5, sheenColor: 0xffffff, sheenRoughness: 0.4 });
  // Hairs are thin and many: a soft sheen, not a glossy highlight each (that read as glitter).
  const hairMat = new THREE.MeshPhysicalMaterial({ roughness: 0.75, sheen: 0.3, sheenColor: 0xffffff, sheenRoughness: 0.5, specularIntensity: 0.3 });

  // ---------- thorax: an egg-shaped box of flight muscle under a coat of long hair ----------
  const TR = new THREE.Vector3(0.0031, 0.0044, 0.0029); // semi-axes
  const thorax = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), cuticle);
  thorax.scale.copy(TR);
  g.add(thorax);
  // Where the red and cream tufts sit underneath (photos), and the olive-grey sheen on top.
  const thoraxColor = (p, n) => {
    const tuft = fbm(p.x * 900 + 5, p.y * 900, 3, 11);
    if (n.z < -0.25 && Math.abs(n.x) > 0.25 && p.y > 0.0005 && tuft > 0.5) return hsl(352, 65, 38 + r() * 10);
    if (n.z < -0.2 && Math.abs(n.x) > 0.4 && p.y < 0.0005 && tuft > 0.55) return hsl(44, 45, 62 + r() * 12);
    if (n.z > 0.3 && r() < 0.25) return hsl(70, 10, 28 + r() * 10);
    return hsl(24, 25, 8 + r() * 8);
  };
  g.add(hairs(2600, () => {
    const u = new THREE.Vector3(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1);
    if (u.lengthSq() > 1 || u.lengthSq() < 1e-4) return null;
    u.normalize();
    const p = u.clone().multiply(TR), n = u.clone().divide(TR).normalize();
    // Hair sweeps back and lies down a little; longest on the back and sides.
    const dir = n.clone().multiplyScalar(0.8).add(new THREE.Vector3(0, -0.55, 0)).addScaledVector(
      new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5), 0.5);
    const len = (n.z > -0.3 ? 0.0009 : 0.0006) * (0.6 + r() * 0.7);
    return { p, dir, len, width: 0.00003, color: thoraxColor(p, n) };
  }, hairMat));
  // Wing-root tufts: long hairs where the wings join, hiding the joint.
  g.add(hairs(500, () => {
    const s = r() < 0.5 ? -1 : 1, y = (r() - 0.5) * 0.0055;
    const p = new THREE.Vector3(s * 0.0024, y, 0.0012 + r() * 0.0008);
    const dir = new THREE.Vector3(s * (0.8 + r() * 0.4), -0.3 + r() * 0.3, 0.3 + r() * 0.3);
    return { p, dir, len: 0.0012 + r() * 0.0008, width: 0.000035, color: hsl(24, 20, 10 + r() * 10) };
  }, hairMat));

  // ---------- abdomen: eight soft segments, hairy; pale underneath ----------
  const AL = 0.022;
  const absRadius = (t) => 0.0024 * Math.pow(Math.sin(Math.PI * (0.08 + 0.9 * t)), 0.7) * (1 - 0.07 * Math.pow(Math.abs(Math.sin(t * Math.PI * 8)), 6));
  const prof = [];
  for (let i = 0; i <= 64; i++) {
    const t = i / 64;
    prof.push(new THREE.Vector2(Math.max(absRadius(t), 0.0002), -0.0035 - (1 - t) * AL));
  }
  const abdomen = new THREE.Mesh(new THREE.LatheGeometry(prof, 32), cuticle);
  abdomen.rotation.x = deg(-6);
  g.add(abdomen);
  g.userData.abdomen = abdomen;
  abdomen.add(hairs(5000, () => {
    const t = r(), a = r() * Math.PI * 2, rad = absRadius(t);
    if (rad < 0.0004) return null;
    const n = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const p = new THREE.Vector3(n.x * rad, -0.0035 - (1 - t) * AL, n.z * rad);
    // Short, lying flat toward the tip; pale tan below, dark above, darker at segment joints.
    const dir = n.clone().multiplyScalar(0.35).add(new THREE.Vector3(0, -1, 0)).addScaledVector(new THREE.Vector3(r() - 0.5, 0, r() - 0.5), 0.3);
    const below = n.z < -0.35;
    const color = below ? hsl(36, 30, 45 + r() * 15) : hsl(24, 22, 9 + r() * 9);
    return { p, dir, len: 0.0006 * (0.6 + r() * 0.6), width: 0.000035, color };
  }, hairMat));

  // ---------- head ----------
  const HEAD = new THREE.Vector3(0, 0.0052, 0.0002);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.0019, 24, 16), cuticle);
  head.position.copy(HEAD);
  head.scale.set(1.05, 0.9, 1);
  g.add(head);
  // Frons and vertex hairs between the eyes.
  g.add(hairs(500, () => {
    const u = new THREE.Vector3(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1).normalize();
    if (Math.abs(u.x) > 0.45) return null; // the eyes cover the sides
    const p = HEAD.clone().addScaledVector(u, 0.0019);
    const dir = u.clone().add(new THREE.Vector3(0, 0.4, 0.2));
    const pale = u.y > 0.5 && u.z < 0.2;
    return { p, dir, len: 0.0006 * (0.6 + r() * 0.6), width: 0.00003, color: pale ? hsl(40, 25, 70) : hsl(24, 25, 10 + r() * 8) };
  }, hairMat));

  // Compound eyes: glossy navy-black, faceted, each in a ring of pale scales.
  const eyeMat = new THREE.MeshPhysicalMaterial({ color: 0x0a0f1e, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.08, normalMap: ommatidiaNormals(), normalScale: new THREE.Vector2(0.6, 0.6) });
  const ringMat = new THREE.MeshPhysicalMaterial({ color: 0xd9d0bb, roughness: 0.8, sheen: 1, sheenColor: 0xffffff });
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.0015, 32, 20), eyeMat);
    eye.position.set(s * 0.0011, HEAD.y + 0.0003, HEAD.z + 0.0002);
    eye.rotation.z = s * Math.PI / 2; // facets laid out around the eye's own axis
    g.add(eye);
    // Hairy eyes, as in the helenor clade (Cassildé et al. 2010): short sparse setae between facets.
    g.add(hairs(400, () => {
      const n = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize();
      if (n.x * s < 0) n.x = -n.x; // outer half only
      return { p: n.clone().multiplyScalar(0.0015).add(eye.position), dir: n, len: 0.00018 * (0.6 + r() * 0.6), width: 0.000012, color: hsl(30, 15, 25 + r() * 20) };
    }, hairMat));
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.00125, 0.00016, 8, 32), ringMat);
    ring.position.set(s * 0.00175, HEAD.y + 0.0003, HEAD.z + 0.0002);
    ring.rotation.y = Math.PI / 2;
    g.add(ring);
  }

  // Labial palps: upturned in front of the face, red outside, white on the inner face.
  for (const s of [-1, 1]) {
    const pts = [[s * 0.0005, HEAD.y + 0.0006, HEAD.z - 0.0016], [s * 0.0008, HEAD.y + 0.0022, HEAD.z - 0.0012],
      [s * 0.0008, HEAD.y + 0.0033, HEAD.z + 0.0002], [s * 0.0005, HEAD.y + 0.0036, HEAD.z + 0.0018]];
    const geo = taperTube(pts, (t) => 0.00038 * (1 - 0.55 * t), (t, n) => (n.x * s > 0.1 ? hsl(355, 45, 40 + 10 * t) : hsl(40, 15, 88)));
    g.add(new THREE.Mesh(geo, tubeMat));
    const curve = geo.userData.curve;
    g.add(hairs(160, () => {
      const t = r(), p = curve.getPointAt(t), tan = curve.getTangentAt(t);
      const side = new THREE.Vector3(s, 0, 0).addScaledVector(tan, -tan.x * s).normalize();
      return { p: p.addScaledVector(side, 0.0002), dir: tan.clone().addScaledVector(side, 0.8), len: 0.0004 * (0.6 + r() * 0.6), width: 0.000025,
        color: r() < 0.6 ? hsl(355, 40, 45) : hsl(40, 15, 88) };
    }, hairMat));
  }

  // Proboscis, coiled like a watch spring between the palps.
  const coil = [];
  for (let i = 0; i <= 60; i++) {
    const t = i / 60, a = t * Math.PI * 2 * 2.5, rad = 0.00075 * (1 - 0.7 * t);
    coil.push([0, HEAD.y + 0.0012 + Math.cos(a) * rad, HEAD.z - 0.0018 - Math.sin(a) * rad]);
  }
  g.add(new THREE.Mesh(taperTube(coil, () => 0.00009, () => hsl(25, 30, 18), { seg: 120, radial: 6 }), tubeMat));

  // Antennae: slender and long, thickening gradually into a club; dark brown with faint pale
  // rings at each segment, a pinkish base and a paler tip.
  // Length 0.36 x forewing (0.052), measured on a dorsal live photo and an M. achilles specimen.
  // Each hangs from a pivot at its base (g.userData.antennae, [left, right]), so it can move.
  const ANT = 0.36 * 0.052;
  const antennae = [];
  for (const s of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(s * 0.0006, HEAD.y + 0.0012, HEAD.z + 0.0015);
    const pts = [[0, 0, 0], [0.0024, 0.3, 0.002], [0.0056, 0.62, 0.0034], [0.0084, 0.95, 0.0038]]
      .map(([x, y, z]) => [s * x * 0.72, y * ANT * 0.97, z * 0.72]);
    const radius = (t) => 0.00011 + 0.00017 * Math.pow(THREE.MathUtils.smoothstep(t, 0.6, 0.93), 1.5) - 0.0001 * THREE.MathUtils.smoothstep(t, 0.95, 1);
    const color = (t) => {
      const ring = Math.pow(Math.abs(Math.sin(t * Math.PI * 40)), 12) * 0.08;
      if (t < 0.06) return hsl(10, 30, 40);
      if (t > 0.9) return hsl(25, 40, 25 + 20 * (t - 0.9) * 10);
      return hsl(22, 25, 13 + ring * 100);
    };
    pivot.add(new THREE.Mesh(taperTube(pts, radius, color, { seg: 160, radial: 8 }), tubeMat));
    g.add(pivot);
    antennae.push(pivot);
  }
  g.userData.antennae = antennae;

  // ---------- legs ----------
  // Nymphalids walk on four legs. Each: coxa under the thorax, femur out and slightly up, tibia
  // down to the wall, tarsus resting on it, with dark spines and a pair of claws.
  // Silvery grey, paler toward the feet (side photo photo-1651940397966), with pale joint bands.
  const legColor = (t) => (Math.abs(t - 0.38) < 0.02 || Math.abs(t - 0.72) < 0.02 ? hsl(40, 8, 85) : hsl(30, 6, 52 + 18 * t));
  const spineMat = new THREE.MeshPhysicalMaterial({ color: 0x1a120c, roughness: 0.5 });
  for (const s of [-1, 1]) {
    // reach scales the footprint so mid/hind legs are ~0.32/0.34 x forewing, as measured on a side photo
    // (mid tibia+tarsus 0.20, hind femur 0.13 x forewing).
    for (const [y0, dy, reach] of [[0.0006, 0.0042, 1.65], [-0.0014, -0.0058, 1.5]]) {
      const pts = [[0.0011, 0, -0.0022], [0.003, dy * 0.15, -0.0018], [0.0058, dy * 0.42, -0.0008],
        [0.0072, dy * 0.75, -0.0026], [0.0078, dy * 0.95, -LEG_DROP + 0.00015], [0.0084, dy * 1.3, -LEG_DROP + 0.0001]]
        .map(([x, y, z]) => [s * (0.0011 + (x - 0.0011) * reach), y0 + y * reach, z]);
      const radius = (t) => (t < 0.38 ? 0.00024 : t < 0.72 ? 0.00017 : 0.00011) * (1 - 0.3 * THREE.MathUtils.smoothstep(t, 0.9, 1));
      const geo = taperTube(pts, radius, legColor, { seg: 64, radial: 8 });
      g.add(new THREE.Mesh(geo, tubeMat));
      const curve = geo.userData.curve;
      // Spines on the tibia and tarsus, pointing down and back along the leg.
      g.add(hairs(26, (i) => {
        const t = 0.42 + (i / 26) * 0.55, p = curve.getPointAt(t), tan = curve.getTangentAt(t);
        return { p, dir: tan.clone().add(new THREE.Vector3(0, 0, -0.7)).add(new THREE.Vector3(s * (r() - 0.5), 0, 0)), len: 0.00028, width: 0.00003, color: hsl(20, 30, 8) };
      }, spineMat));
      // Claws.
      g.add(hairs(2, (i) => {
        const p = curve.getPointAt(1), tan = curve.getTangentAt(1);
        return { p, dir: tan.clone().add(new THREE.Vector3((i - 0.5) * 0.8, 0, -0.6)), len: 0.00025, width: 0.00004, color: hsl(20, 30, 6) };
      }, spineMat));
    }
    // Forelegs: small, folded against the chest, covered in long pale hair (the "brush").
    const fpts = [[s * 0.0008, 0.0022, -0.0018], [s * 0.0016, 0.0034, -0.0026], [s * 0.0012, 0.0046, -0.0022]];
    const fgeo = taperTube(fpts, () => 0.00018, () => hsl(30, 20, 40));
    g.add(new THREE.Mesh(fgeo, tubeMat));
    g.add(hairs(120, () => {
      const t = r(), p = fgeo.userData.curve.getPointAt(t);
      return { p, dir: new THREE.Vector3((r() - 0.5) + s * 0.5, 0.3, -0.8 + r() * 0.4), len: 0.0007 * (0.6 + r() * 0.6), width: 0.00003, color: hsl(40, 25, 60 + r() * 15) };
    }, hairMat));
  }
  return g;
}
