import * as THREE from 'three/webgpu';
import { uniform, positionWorld, time, smoothstep, mix, vec3, exp, fract, mx_noise_float } from 'three/tsl';
import { fbm } from './noise.js';

// Only the butterfly is real. It stands on a wall built of lines: a fine net that follows a few mm
// of relief, over two coarser grids further back tied to it by posts, so the wall has depth seen
// from any angle. The lines fade out with distance from the butterfly into a dark space that goes
// on without end, where specks of light drift slowly away. When the butterfly leaves, the wall goes
// with it. The lines glow (they are the only light back there), the butterfly's shadow still falls
// on the net, and both reach the butterfly through its environment capture.

export const VOID = 0x010103; // the colour of the space behind
const SPAN = 1.2;             // m, extent of the line wall (the butterfly lands within the view)
const NET = 0.004;            // m, spacing of the front net
const RELIEF = 0.004;         // m, peak-to-peak relief of the front net
const LAYERS = [[-0.015, 0.012], [-0.04, 0.024]]; // [depth, spacing] of the grids behind

function latticeGeometry() {
  const v = [];
  const seg = (a, b) => v.push(...a, ...b);
  const n = Math.round(SPAN / NET), h0 = -SPAN / 2;
  // Front net, heights from the same kind of fBm the plaster used.
  const H = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) H.push((fbm(i * NET * 12 + 50, j * NET * 12 + 50, 4, 3) - 0.5) * RELIEF);
  }
  const P = (i, j) => [h0 + i * NET, h0 + j * NET, H[j * (n + 1) + i]];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i < n; i++) { seg(P(i, j), P(i + 1, j)); seg(P(j, i), P(j, i + 1)); }
  }
  // Grids behind, each tied to the layer in front by posts at its own spacing.
  let front = 0;
  for (const [z, step] of LAYERS) {
    const m = Math.round(SPAN / step);
    for (let a = 0; a <= m; a++) {
      const t = h0 + a * step;
      seg([h0, t, z], [-h0, t, z]);
      seg([t, h0, z], [t, -h0, z]);
      for (let b = 0; b <= m; b++) seg([t, h0 + b * step, front], [t, h0 + b * step, z]);
    }
    front = z;
  }
  return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
}

export function buildRift() {
  const centre = uniform(new THREE.Vector2()), radius = uniform(0);

  // ---------- the wall of lines ----------
  const pw = positionWorld;
  const d = pw.xy.sub(centre).length();
  const reach = radius.mul(mx_noise_float(vec3(pw.xy.mul(20), time.mul(0.1))).mul(0.25).add(1)); // ragged ±25%
  const fade = smoothstep(reach.mul(0.35), reach, d).oneMinus();
  const depthDim = mix(0.3, 1, smoothstep(-0.04, 0, pw.z));
  // A faint ring sweeping out from the butterfly now and then.
  const ring = exp(d.sub(fract(time.mul(0.15)).mul(radius).mul(1.6)).div(0.004).pow(2).negate()).mul(0.8);
  const lineMaterial = new THREE.LineBasicNodeMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  lineMaterial.colorNode = vec3(0.35, 0.75, 1).mul(fade).mul(depthDim).mul(ring.add(0.6));
  const lattice = latticeGeometry();
  const lines = new THREE.LineSegments(lattice, lineMaterial);
  lines.frustumCulled = false;
  const envLines = new THREE.LineSegments(lattice, lineMaterial);

  // Shadows on the net: a surface that draws nothing but the shadow, over the lines behind it.
  const shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowNodeMaterial({ opacity: 0.7 }));
  shadowCatcher.receiveShadow = true;
  shadowCatcher.renderOrder = 1;
  const wall = new THREE.Group().add(lines, shadowCatcher);

  // ---------- the space behind ----------
  // Nothing is drawn for it: the camera always faces the wall, so the scene background (set to VOID
  // in main.js) is all that shows. Depth comes from specks drifting slowly away, shrinking below a
  // pixel long before they stop.
  const FAR = 50;
  const r = Math.random;
  const SPECKS = 3000;
  const specks = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshBasicNodeMaterial(), SPECKS);
  specks.frustumCulled = false;
  const m = new THREE.Matrix4(), c = new THREE.Color();
  // Spread wider with depth, roughly filling what can be seen.
  const place = (sp, z) => sp.pos.set((r() - 0.5) * (0.6 + Math.abs(z) * 1.6), (r() - 0.5) * (0.6 + Math.abs(z) * 1.6), z);
  const drift = Array.from({ length: SPECKS }, (_, i) => {
    specks.setColorAt(i, c.setHSL(0.58 + 0.12 * r(), 0.3, 0.6).multiplyScalar(0.5 + 3 * r() ** 4));
    const sp = { pos: new THREE.Vector3(), speed: 0.01 + 0.04 * r(), size: 0.0002 + 0.0005 * r() };
    place(sp, -0.05 - FAR * 0.9 * r() * r());
    return sp;
  });

  function update(dt, cx, cy, rad) {
    centre.value.set(cx, cy);
    radius.value = rad;
    shadowCatcher.position.set(cx, cy, 0);
    shadowCatcher.scale.setScalar(Math.max(rad * 2.6, 1e-6));
    for (let i = 0; i < SPECKS; i++) {
      const sp = drift[i];
      sp.pos.z -= sp.speed * dt;
      if (sp.pos.z < -FAR * 0.9) place(sp, -0.05 - 0.5 * r());
      const size = sp.size * (1 + Math.abs(sp.pos.z) * 0.6); // grows slower than distance: fades with depth
      specks.setMatrixAt(i, m.makeScale(size, size, size).setPosition(sp.pos));
    }
    specks.instanceMatrix.needsUpdate = true;
  }

  // For the environment capture, which keeps the garden sky in front: behind the wall it is dark
  // but for the lines. Uniform, and only ever seen blurred, so the dark can be a plane.
  const envBehind = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshBasicNodeMaterial({ color: VOID }));
  envBehind.position.z = -0.05;
  const envWall = new THREE.Group().add(envLines, envBehind);

  return { wall, space: specks, envWall, update };
}
