import * as THREE from 'three/webgpu';
import { attribute, uniform, vec3 } from 'three/tsl';

// Effects that follow what the butterfly does: thin light trails from the forewing tips while it
// flies, rings spreading over the wall where it lands, and glowing blue scales shed as it beats its
// wings (a few in flight each second, now and then at rest), drifting down and fading.

const TRAIL = 48;         // samples per trail (~0.8 s at 60 fps)
const RING_LIFE = 1.6;    // s
const RING_REACH = 0.07;  // m, radius a ring grows to
const DUST = 240;         // scales alive at most
const DUST_RATE = { flying: 50, rest: 1 }; // shed per second
const CYAN = vec3(0.55, 0.9, 1);

export function buildMotion({ scene, camera, bf }) {
  const group = new THREE.Group();
  scene.add(group);
  const flying = (mode) => mode === 'takeoff' || mode === 'landing';

  // ---------- trails ----------
  // Each forewing's tip: the outline point farthest from its root, in the wing mesh's frame.
  const tipOf = (pts) => pts.reduce((a, p) => (p.lengthSq() > a.lengthSq() ? p : a));
  const trailOn = uniform(0);
  const trails = bf.pivots.filter((p) => !p.userData.hind).map((p) => {
    const tip = tipOf(bf.wings[0].pts);
    const pos = new Float32Array(TRAIL * 3), age = new Float32Array(TRAIL).map((_, i) => i / (TRAIL - 1));
    const geo = new THREE.BufferGeometry()
      .setAttribute('position', new THREE.BufferAttribute(pos, 3))
      .setAttribute('age', new THREE.BufferAttribute(age, 1));
    const mat = new THREE.LineBasicNodeMaterial({ transparent: true, blending: THREE.AdditiveBlending });
    // Brightest at the wing, gone at the tail; lines write depth so the depth of field blurs them.
    mat.colorNode = CYAN.mul(attribute('age', 'float').oneMinus().pow(1.5)).mul(trailOn).mul(2.5);
    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    group.add(line);
    return { mesh: p.children[0], local: new THREE.Vector3(tip.x, tip.y, 0), pos, geo, filled: false };
  });

  // ---------- landing rings ----------
  const ringGeo = new THREE.RingGeometry(0.96, 1, 96);
  const rings = [0, 0.25, 0.5].map((delay) => {
    const alpha = uniform(0);
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    mat.colorNode = CYAN.mul(alpha);
    const mesh = new THREE.Mesh(ringGeo, mat);
    mesh.visible = false;
    group.add(mesh);
    return { mesh, alpha, delay, t: Infinity };
  });

  // ---------- scales ----------
  const dustMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const dust = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), dustMat, DUST);
  dust.frustumCulled = false;
  const black = new THREE.Color(0, 0, 0);
  for (let i = 0; i < DUST; i++) dust.setColorAt(i, black);
  group.add(dust);
  const motes = Array.from({ length: DUST }, () => ({ life: 0, age: 0, p: new THREE.Vector3(), v: new THREE.Vector3(), size: 0, seed: 0 }));
  let next = 0, owed = 0;
  const v = new THREE.Vector3(), m = new THREE.Matrix4(), s = new THREE.Vector3(), c = new THREE.Color();
  function shed() {
    const piv = bf.pivots[Math.floor(Math.random() * bf.pivots.length)];
    const pts = bf.wings[piv.userData.hind ? 1 : 0].pts, q = pts[Math.floor(Math.random() * pts.length)], f = 0.3 + 0.7 * Math.random();
    const d = motes[next];
    next = (next + 1) % DUST;
    d.p.set(q.x * f, q.y * f, 0);
    piv.children[0].localToWorld(d.p);
    // A puff off the wing, then a slow fall (est.: scales are ~0.1 mm and flutter down).
    d.v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.3).multiplyScalar(0.03);
    d.life = 1.5 + 1.5 * Math.random();
    d.age = 0;
    d.size = 0.0006 + 0.0008 * Math.random(); // m: drawn larger than a scale, so its glow reads
    d.seed = Math.random() * 100;
  }

  let prevMode = null;
  function update(dt, mode) {
    bf.group.updateMatrixWorld();
    const fly = flying(mode);

    // Trails: shift back one sample and add the tip where it is now.
    trailOn.value = THREE.MathUtils.damp(trailOn.value, fly ? 1 : 0, fly ? 8 : 3, dt);
    for (const t of trails) {
      v.copy(t.local);
      t.mesh.localToWorld(v);
      if (!t.filled) { for (let i = 0; i < TRAIL; i++) v.toArray(t.pos, i * 3); t.filled = true; }
      t.pos.copyWithin(3, 0, (TRAIL - 1) * 3);
      v.toArray(t.pos, 0);
      t.geo.attributes.position.needsUpdate = true;
    }

    // Rings: set off at touchdown, around the feet, just above the wall.
    if (mode === 'rest' && prevMode && prevMode !== 'rest') for (const r of rings) r.t = -r.delay;
    prevMode = mode;
    for (const r of rings) {
      r.t += dt;
      const k = r.t / RING_LIFE;
      r.mesh.visible = k >= 0 && k < 1;
      if (!r.mesh.visible) continue;
      r.mesh.position.set(bf.group.position.x, bf.group.position.y, 0.001);
      r.mesh.scale.setScalar(0.004 + RING_REACH * (1 - (1 - k) ** 3));
      r.alpha.value = (1 - k) ** 2 * 0.7;
    }

    // Scales.
    if (bf.group.visible) {
      owed += dt * (fly ? DUST_RATE.flying : DUST_RATE.rest);
      for (; owed >= 1; owed--) shed();
    }
    for (let i = 0; i < DUST; i++) {
      const d = motes[i];
      if (d.age < d.life) {
        d.age += dt;
        d.v.multiplyScalar(Math.exp(-2 * dt)).add(s.set(0, -0.02 * dt, 0)); // air drag, a gentle sink
        d.p.addScaledVector(d.v, dt);
      }
      const k = d.age / d.life, glow = k < 1 ? (1 - k) * (0.6 + 0.4 * Math.sin(d.age * 18 + d.seed)) : 0;
      m.compose(d.p, camera.quaternion, s.setScalar(glow > 0 ? d.size : 0));
      dust.setMatrixAt(i, m);
      dust.setColorAt(i, c.setRGB(0.25 * glow, 0.55 * glow, 1.3 * glow));
    }
    dust.instanceMatrix.needsUpdate = true;
    dust.instanceColor.needsUpdate = true;
  }

  return { update };
}
