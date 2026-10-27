import * as THREE from 'three/webgpu';
import { uv, vec3, exp } from 'three/tsl';

// Glittering scales shed from the wings (many in flight, a steady few at rest): small four-point
// stars that twinkle as they drift down and fade.

const DUST = 240;         // scales alive at most
const DUST_RATE = { flying: 50, rest: 6 }; // shed per second, from points on the wings

export function buildMotion({ scene, camera, bf }) {
  // They write depth, or the depth of field takes them for the wall behind and blurs them away; but
  // only where the star shows (the rest of the quad is discarded), or each would cut a square out of
  // the blur and of the butterfly's mask.
  const dustMat = new THREE.MeshBasicNodeMaterial({ transparent: true, blending: THREE.AdditiveBlending, alphaTest: 0.03 });
  // A star: a soft core and two thin crossed rays, fading to nothing at the quad's edge.
  const q = uv().sub(0.5), ax = q.x.abs(), ay = q.y.abs();
  const rays = exp(ax.mul(-30)).mul(exp(ay.mul(-6))).add(exp(ay.mul(-30)).mul(exp(ax.mul(-6))));
  const star = exp(q.dot(q).mul(-60)).add(rays.mul(0.8)).mul(q.length().mul(2).oneMinus().clamp(0, 1));
  dustMat.colorNode = vec3(star.mul(3));
  dustMat.opacityNode = star;
  const dust = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), dustMat, DUST);
  dust.frustumCulled = false;
  const black = new THREE.Color(0, 0, 0);
  for (let i = 0; i < DUST; i++) dust.setColorAt(i, black);
  scene.add(dust);
  const motes = Array.from({ length: DUST }, () => ({ life: 0, age: 0, p: new THREE.Vector3(), v: new THREE.Vector3(), size: 0, seed: 0 }));
  let next = 0, owed = 0;
  const m = new THREE.Matrix4(), s = new THREE.Vector3(), c = new THREE.Color();
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
    d.size = 0.002 + 0.003 * Math.random(); // m: the star's rays reach far beyond the ~0.1 mm scale
    d.seed = Math.random() * 100;
  }

  function update(dt, mode) {
    bf.group.updateMatrixWorld();

    if (bf.group.visible) {
      owed += dt * (mode === 'takeoff' || mode === 'landing' ? DUST_RATE.flying : DUST_RATE.rest);
      for (; owed >= 1; owed--) shed();
    }
    for (let i = 0; i < DUST; i++) {
      const d = motes[i];
      if (d.age < d.life) {
        d.age += dt;
        d.v.multiplyScalar(Math.exp(-2 * dt)).add(s.set(0, -0.02 * dt, 0)); // air drag, a gentle sink
        d.p.addScaledVector(d.v, dt);
      }
      // Twinkle: mostly dim, flashing bright now and then.
      const k = d.age / d.life, glow = k < 1 ? (1 - k) * (0.25 + 1.6 * (0.5 + 0.5 * Math.sin(d.age * 9 + d.seed)) ** 6) : 0;
      m.compose(d.p, camera.quaternion, s.setScalar(glow > 0 ? d.size : 0));
      dust.setMatrixAt(i, m);
      dust.setColorAt(i, c.setRGB(0.55 * glow, 0.8 * glow, 1.3 * glow));
    }
    dust.instanceMatrix.needsUpdate = true;
    dust.instanceColor.needsUpdate = true;
  }

  return { update };
}
