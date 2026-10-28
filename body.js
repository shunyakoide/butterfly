import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
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

// The same hair as a piece of geometry, for the legs, whose parts are skinned.
function hairGeometry(h) {
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), h.dir.normalize());
  return HAIR.clone().applyMatrix4(new THREE.Matrix4().compose(h.p, q, new THREE.Vector3(h.width, h.len, h.width)));
}
// Binds every vertex of geo wholly to one bone.
function skin(geo, bone) {
  const n = geo.attributes.position.count, index = new Uint16Array(n * 4), weight = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { index[i * 4] = bone; weight[i * 4] = 1; }
  return geo.setAttribute('skinIndex', new THREE.BufferAttribute(index, 4)).setAttribute('skinWeight', new THREE.BufferAttribute(weight, 4));
}
const Z = new THREE.Vector3(0, 0, 1);
// A rotation whose x axis is along x and y axis as close to y as allows.
function frame(x, y) {
  const X = x.clone().normalize(), Y = y.clone().addScaledVector(X, -y.dot(X)).normalize();
  return new THREE.Matrix4().makeBasis(X, Y, new THREE.Vector3().crossVectors(X, Y));
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
  // Under the hair the body never shows bare: velvet, a sheen at grazing angles and no highlight
  // (a glossy cuticle peeked through as a plastic spot).
  const cuticle = new THREE.MeshPhysicalMaterial({ color: 0x0e0a07, roughness: 1, specularIntensity: 0.1, sheen: 1, sheenColor: 0x382c22, sheenRoughness: 0.7 });
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
    if (n.z > 0.3 && r() < 0.25) return hsl(70, 10, 20 + r() * 8);
    return hsl(24, 25, 5 + r() * 6);
  };
  g.add(hairs(7000, () => {
    const u = new THREE.Vector3(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1);
    if (u.lengthSq() > 1 || u.lengthSq() < 1e-4) return null;
    u.normalize();
    const p = u.clone().multiply(TR), n = u.clone().divide(TR).normalize();
    // A dense pile combed back along the surface, lifting only a little off it (photos: the thorax
    // reads as velvet, not as separate hairs).
    const back = new THREE.Vector3(0, -1, 0).addScaledVector(n, n.y);
    const dir = back.normalize().addScaledVector(n, 0.45).addScaledVector(
      new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5), 0.25);
    const len = (n.z > -0.3 ? 0.0009 : 0.0006) * (0.6 + r() * 0.7);
    return { p, dir, len, width: 0.000025, color: thoraxColor(p, n) };
  }, hairMat));
  // Wing-root tufts: long hairs where the wings join, hiding the joint.
  // They fan back over the wing bases and lie on them, longest at the middle of the joint, so the
  // tuft has a ragged edge rather than a comb's straight one.
  g.add(hairs(700, () => {
    const s = r() < 0.5 ? -1 : 1, k = r() * 2 - 1, y = k * 0.0028;
    const p = new THREE.Vector3(s * (0.0022 + r() * 0.0004), y, 0.0010 + r() * 0.0008);
    const dir = new THREE.Vector3(s * (0.7 + r() * 0.5), -0.25 - 0.5 * r() + 0.3 * k, 0.05 + r() * 0.2);
    const len = (0.0006 + r() * 0.0014) * (1 - 0.5 * k * k);
    return { p, dir, len, width: 0.00003, color: hsl(24, 20, 7 + r() * 8) };
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
  abdomen.add(hairs(9000, () => {
    const t = r(), a = r() * Math.PI * 2, rad = absRadius(t);
    if (rad < 0.0004) return null;
    const n = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const p = new THREE.Vector3(n.x * rad, -0.0035 - (1 - t) * AL, n.z * rad);
    // Short, lying flat toward the tip; pale tan below, dark above; shorter and darker at the joints
    // between the eight segments, so the rings show through the hair (est., from side photos).
    const dir = n.clone().multiplyScalar(0.3).add(new THREE.Vector3(0, -1, 0)).addScaledVector(new THREE.Vector3(r() - 0.5, 0, r() - 0.5), 0.2);
    const joint = Math.pow(Math.abs(Math.sin(t * Math.PI * 8)), 4); // where absRadius narrows
    const below = n.z < -0.35;
    const color = below ? hsl(36, 30, (45 + r() * 15) * (1 - 0.4 * joint)) : hsl(24, 22, (8 + r() * 8) * (1 - 0.75 * joint));
    return { p, dir, len: 0.0006 * (0.6 + r() * 0.6) * (1 - 0.6 * joint), width: 0.00003, color };
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
    // Combed forward over the head, as on the thorax, lifting a little at the front.
    const dir = new THREE.Vector3(0, 1, 0).projectOnPlane(u).normalize().addScaledVector(u, 0.5)
      .addScaledVector(new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5), 0.25);
    const pale = u.y > 0.5 && u.z < 0.2;
    return { p, dir, len: 0.0006 * (0.6 + r() * 0.6), width: 0.00003, color: pale ? hsl(40, 25, 70) : hsl(24, 25, 10 + r() * 8) };
  }, hairMat));

  // Compound eyes: glossy navy-black, faceted, each in a ring of pale scales.
  const eyeMat = new THREE.MeshPhysicalMaterial({ color: 0x0a0f1e, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.08, normalMap: ommatidiaNormals(), normalScale: new THREE.Vector2(0.6, 0.6) });
  const ringMat = new THREE.MeshPhysicalMaterial({ color: 0x9c9282, roughness: 0.8, sheen: 0.3, sheenColor: 0xffffff });
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
    // A narrow band of scales round the eye's rim, ~60 µm (est., photos); thicker read as a white frame.
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.00133, 0.00006, 6, 40), ringMat);
    ring.position.set(s * 0.00175, HEAD.y + 0.0003, HEAD.z + 0.0002);
    ring.rotation.y = Math.PI / 2;
    g.add(ring);
  }

  // Labial palps: a pair pressed together in front of the face like a beak, jutting forward and
  // turning up to about the top of the eyes (photos); red outside, white on the inner face.
  for (const s of [-1, 1]) {
    const pts = [[s * 0.00035, HEAD.y + 0.0008, HEAD.z - 0.0014], [s * 0.00045, HEAD.y + 0.0021, HEAD.z - 0.0009],
      [s * 0.0004, HEAD.y + 0.0031, HEAD.z + 0.0001], [s * 0.0003, HEAD.y + 0.0035, HEAD.z + 0.0008]];
    const radius = (t) => 0.00034 * (1 - 0.55 * t);
    const color = (n) => (n.x * s > 0.1 ? hsl(355, 45, 42) : hsl(40, 18, 72));
    const geo = taperTube(pts, radius, (t, n) => color(n));
    g.add(new THREE.Mesh(geo, tubeMat));
    const curve = geo.userData.curve;
    // Densely scaled: short scales all round the surface, lying forward along the palp.
    g.add(hairs(420, () => {
      const t = r(), tan = curve.getTangentAt(t);
      const n = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).projectOnPlane(tan).normalize();
      return { p: curve.getPointAt(t).addScaledVector(n, radius(t)), dir: tan.clone().addScaledVector(n, 0.5), len: 0.0003 * (0.6 + r() * 0.6), width: 0.000025, color: color(n) };
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
    // The club swells from two thirds of the way out to about 2.5x the shaft (photos) and ends in
    // a rounded tip; an open end read as a cut-off stick.
    const radius = (t) => {
      const club = 0.0001 + 0.00015 * THREE.MathUtils.smoothstep(t, 0.62, 0.9);
      const e = Math.max(0, (t - 0.93) / 0.07);
      return club * Math.sqrt(Math.max(0, 1 - e * e)) + 0.000005;
    };
    const color = (t) => {
      const ring = Math.pow(Math.abs(Math.sin(t * Math.PI * 40)), 12) * 0.06;
      if (t < 0.06) return hsl(10, 30, 32);
      if (t > 0.62) return hsl(24, 35, 9 + 9 * THREE.MathUtils.smoothstep(t, 0.75, 1)); // the club warms toward the tip
      return hsl(22, 20, 8 + ring * 100);
    };
    pivot.add(new THREE.Mesh(taperTube(pts, radius, color, { seg: 160, radial: 8 }), tubeMat));
    g.add(pivot);
    antennae.push(pivot);
  }
  g.userData.antennae = antennae;

  // ---------- legs ----------
  // Nymphalids walk on four legs.
  // Silvery grey, paler toward the feet (side photo photo-1651940397966).
  const legColor = (l) => () => hsl(30, 6, l);
  // The spines lost their per-hair colour (hsl 20,30,8) when they left the instanced mesh: folded in here.
  const spineMat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(0x1a120c).multiply(hsl(20, 30, 8)), roughness: 0.5 });
  const jointMat = new THREE.MeshPhysicalMaterial({ color: hsl(30, 6, 54), roughness: 0.7 });
  const V = (a) => new THREE.Vector3(...a);
  // The walking legs bend (pose, below), so each segment moves with a bone: the coxa, femur, tibia
  // and tarsus of each leg. All the segments are one skinned mesh, the spines and claws another,
  // and the joints one instanced mesh, so the jointed legs cost three draws, not one per segment.
  const legTubes = [], legSpines = [], joints = [], legs = [], bones = [];
  // One straight segment of a leg, tapering from r0 to r1, rounded off at its far joint.
  const segment = (a, b, r0, r1, l, bone, next = r1) => {
    legTubes.push(skin(taperTube([a, b], (t) => r0 + (r1 - r0) * t, legColor(l), { seg: 4, radial: 8 }), bone));
    joints.push({ bone, m: new THREE.Matrix4().compose(V(b), new THREE.Quaternion(), new THREE.Vector3().setScalar(Math.min(r1, next))) });
  };
  for (const s of [-1, 1]) {
    // reach scales the footprint so mid/hind legs are ~0.32/0.34 x forewing, as measured on a side photo
    // (mid tibia+tarsus 0.20, hind femur 0.13 x forewing).
    for (const [y0, dy, reach] of [[0.0006, 0.0042, 1.65], [-0.0014, -0.0058, 1.5]]) {
      const at = ([x, y, z]) => [s * (0.0011 + (x - 0.0011) * reach), y0 + y * reach, z];
      // Coxa under the thorax; femur out and up to a sharp knee; tibia straight down to the wall;
      // the tarsus along it in five tarsomeres, the first as long as the other four (est., from
      // nymphalid leg diagrams), ending in a pair of claws.
      const coxa = at([0.0011, 0, -0.0022]), troch = at([0.0026, dy * 0.12, -0.0019]);
      const knee = at([0.0058, dy * 0.42, -0.0006]), ankle = at([0.0074, dy * 0.85, -LEG_DROP + 0.00012]);
      const tip = at([0.0084, dy * 1.3, -LEG_DROP + 0.00008]);
      const bone = bones.length;
      for (let k = 0; k < 4; k++) bones.push(new THREE.Bone());
      segment(coxa, troch, 0.00026, 0.00024, 48, bone);
      segment(troch, knee, 0.00024, 0.0002, 55, bone + 1, 0.00017);
      segment(knee, ankle, 0.00017, 0.00014, 62, bone + 2, 0.00011);
      const tars = [0, 0.5, 0.625, 0.75, 0.875, 1].map((f) => V(ankle).lerp(V(tip), f).toArray());
      for (let k = 0; k < 5; k++) segment(tars[k], tars[k + 1], 0.00011 - k * 0.000006, 0.000105 - k * 0.000006, 66 + k * 2, bone + 3);
      // Spines on the tibia and tarsus, pointing down and back along the leg.
      const tibia = [V(knee), V(ankle)], tarsus = [V(ankle), V(tip)];
      for (let i = 0; i < 26; i++) {
        const [a, b] = i < 14 ? tibia : tarsus, f = i < 14 ? (i + 0.5) / 14 : (i - 13.5) / 12;
        const tan = b.clone().sub(a).normalize();
        legSpines.push(skin(hairGeometry({ p: a.clone().lerp(b, f), dir: tan.add(new THREE.Vector3(0, 0, -0.7)).add(new THREE.Vector3(s * (r() - 0.5), 0, 0)), len: 0.00028, width: 0.00003 }), i < 14 ? bone + 2 : bone + 3));
      }
      // Claws, hooked down into the wall.
      for (let i = 0; i < 2; i++) {
        const tan = V(tip).sub(V(ankle)).normalize();
        legSpines.push(skin(hairGeometry({ p: V(tip), dir: tan.add(new THREE.Vector3((i - 0.5) * 0.8, 0, -0.6)), len: 0.00025, width: 0.00004 }), bone + 3));
      }
      const l = { bone, troch: V(troch), knee: V(knee), ankle: V(ankle), tip: V(tip) };
      l.l1 = l.knee.distanceTo(l.troch);
      l.l2 = l.ankle.distanceTo(l.knee);
      const n = new THREE.Vector3().crossVectors(l.knee.clone().sub(l.troch), l.ankle.clone().sub(l.troch));
      l.rest = [frame(l.knee.clone().sub(l.troch), n), frame(l.ankle.clone().sub(l.knee), n), frame(l.tip.clone().sub(l.ankle), Z)];
      legs.push(l);
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
  const legMesh = new THREE.SkinnedMesh(mergeGeometries(legTubes), tubeMat.clone());
  const spineMesh = new THREE.SkinnedMesh(mergeGeometries(legSpines), spineMat);
  for (const b of bones) { b.matrixAutoUpdate = false; legMesh.add(b); }
  // Bones and meshes all sit in this frame, so a bone's matrix is how far its segment has moved.
  const skeleton = new THREE.Skeleton(bones, bones.map(() => new THREE.Matrix4()));
  for (const m of [legMesh, spineMesh]) { m.bind(skeleton, new THREE.Matrix4()); m.frustumCulled = false; g.add(m); }
  const knobs = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8), jointMat, joints.length);
  g.add(knobs);

  // Bends the four walking legs ([left mid, left hind, right mid, right hind]) so each foot lands
  // where asked: feet[i] = { ankle, tip, knee? } and up (the wall's normal) in this frame. Femur and tibia
  // reach for the ankle, the knee kept in the plane through the given knee point, or its rest position (two-bone IK); the
  // tarsus lies from there toward the tip. Without feet, the legs return to their rest pose.
  const m = new THREE.Matrix4();
  const place = (bone, a0, f0, a, f) => {
    const b = bones[bone].matrix.multiplyMatrices(f, m.copy(f0).transpose());
    b.setPosition(a.clone().sub(a0.clone().applyMatrix4(b)));
  };
  function pose(feet, up) {
    legs.forEach((l, i) => {
      if (!feet) {
        for (let k = 1; k < 4; k++) bones[l.bone + k].matrix.identity();
        return;
      }
      const T = l.troch, to = feet[i].ankle.clone().sub(T);
      const d = THREE.MathUtils.clamp(to.length(), Math.abs(l.l1 - l.l2) + 1e-6, (l.l1 + l.l2) * 0.999), u = to.normalize();
      const v = (feet[i].knee ?? l.knee).clone().sub(T);
      v.addScaledVector(u, -v.dot(u)).normalize();
      const a = (l.l1 * l.l1 - l.l2 * l.l2 + d * d) / (2 * d);
      const K = T.clone().addScaledVector(u, a).addScaledVector(v, Math.sqrt(Math.max(0, l.l1 * l.l1 - a * a)));
      const A = T.clone().addScaledVector(u, d), n = new THREE.Vector3().crossVectors(K.clone().sub(T), u);
      place(l.bone + 1, T, l.rest[0], T, frame(K.clone().sub(T), n));
      place(l.bone + 2, l.knee, l.rest[1], K, frame(A.clone().sub(K), n));
      place(l.bone + 3, l.ankle, l.rest[2], A, frame(feet[i].tip.clone().sub(A), up));
    });
    joints.forEach((j, k) => knobs.setMatrixAt(k, m.multiplyMatrices(bones[j.bone].matrix, j.m)));
    knobs.instanceMatrix.needsUpdate = true;
  }
  pose();
  // Foot targets for the air (flight.js): folded in under the body, the femur laid back along it, the
  // tibia folded forward against it and the tarsus trailing (est.), and reaching out toward the wall
  // before touchdown, a little further and more forward than standing (est.).
  const tuck = legs.map((l) => {
    const s = Math.sign(l.troch.x), ankle = l.troch.clone().add(new THREE.Vector3(s * 0.0006, -0.002, -0.0012));
    return { ankle, tip: ankle.clone().add(new THREE.Vector3(s * 0.0004, -0.003, -0.0006)), knee: l.troch.clone().add(new THREE.Vector3(s * 0.0008, -0.0055, 0.0002)) };
  });
  const reach = legs.map((l) => {
    const ankle = l.ankle.clone().add(new THREE.Vector3(0, 0.0012, -0.0008));
    return { ankle, tip: ankle.clone().add(l.tip.clone().sub(l.ankle)), knee: l.knee };
  });
  g.userData.legs = { rest: legs.map((l) => ({ ankle: l.ankle, tip: l.tip, knee: l.knee })), tuck, reach, pose };
  return g;
}
