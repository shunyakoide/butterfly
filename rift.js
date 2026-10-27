import * as THREE from 'three/webgpu';
import { uniform, attribute, positionGeometry, time, smoothstep, mix, vec3, exp, fract, sin, hash, select } from 'three/tsl';

// Only the butterfly is real. It stands on a wall built of lines: square columns drawn as
// outlines, their tops level into a platform under the butterfly and, further out, dropped to
// scattered depths, sinking away into a dark space that goes on without end, where specks of light
// drift. The columns are placed in the vertex shader, so the platform forms wherever the butterfly
// is; when it leaves, the whole wall sinks, and rises again when it returns. The lines glow (the
// only light back there), the butterfly's shadow still falls on the platform, and both reach the
// butterfly through its environment capture.

export const VOID = 0x010103; // the colour of the space behind
const SPAN = 1.0;   // m, extent of the wall (the butterfly lands within the middle of the view)
const CELL = 0.005; // m, column pitch; each column is drawn 84% of it wide, so they read apart

// One quad per column top, for the columns drawn filled.
function facesGeometry() {
  const n = Math.round(SPAN / CELL), h0 = -SPAN / 2, a = CELL * 0.42;
  const quad = [[-a, -a], [a, -a], [a, a], [-a, -a], [a, a], [-a, a]];
  const pos = [], cell = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const cx = h0 + (i + 0.5) * CELL, cy = h0 + (j + 0.5) * CELL;
      for (const [x, y] of quad) { pos.push(cx + x, cy + y, 0); cell.push(cx, cy); }
    }
  }
  return new THREE.BufferGeometry()
    .setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    .setAttribute('cell', new THREE.Float32BufferAttribute(cell, 2));
}

// Per column: the 4 edges of its top and its 4 corner posts. z is 0 at the top and -1 at the foot;
// the shader places it.
function columnsGeometry() {
  const n = Math.round(SPAN / CELL), h0 = -SPAN / 2, a = CELL * 0.42;
  const corners = [[-a, -a], [a, -a], [a, a], [-a, a]];
  const pos = [], cell = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const cx = h0 + (i + 0.5) * CELL, cy = h0 + (j + 0.5) * CELL;
      for (let k = 0; k < 4; k++) {
        const [x0, y0] = corners[k], [x1, y1] = corners[(k + 1) % 4];
        pos.push(cx + x0, cy + y0, 0, cx + x1, cy + y1, 0, cx + x0, cy + y0, 0, cx + x0, cy + y0, -1);
        for (let v = 0; v < 4; v++) cell.push(cx, cy);
      }
    }
  }
  return new THREE.BufferGeometry()
    .setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    .setAttribute('cell', new THREE.Float32BufferAttribute(cell, 2));
}

export function buildRift() {
  const centre = uniform(new THREE.Vector2()), radius = uniform(0);

  // ---------- the wall of lines ----------
  const cell = attribute('cell', 'vec2'), g = positionGeometry;
  const d = cell.sub(centre).length();
  const h = hash(cell.x.mul(7919).add(cell.y.mul(104729)));
  // 0 on the platform, 1 well away from it (or everywhere, while the butterfly is away).
  const drop = smoothstep(radius.mul(0.6), radius.mul(2.2).add(0.001), d);
  // Platform tops jitter by ~1 mm; dropped columns sink 2-27 cm and bob slowly.
  const sink = mix(h.mul(0.0015), h.mul(h).mul(0.25).add(0.02).add(sin(time.mul(0.5).add(h.mul(6.283))).mul(0.01)), drop);
  const length = mix(0.004, 0.035, drop); // m, how far each column's posts reach back
  // Mixed looks: ~70% of columns are outlines, ~20% filled blocks, ~10% shrunk to a pixel-like dot.
  const style = hash(cell.x.mul(3571).add(cell.y.mul(6197)));
  const filled = style.lessThan(0.2), dot = style.greaterThan(0.9);
  const around = (k) => vec3(cell.x.add(g.x.sub(cell.x).mul(k)), cell.y.add(g.y.sub(cell.y).mul(k)), 0);
  // Opaque, so nearer lines hide farther ones: added up, the platform blew out to white at grazing angles.
  const lineMaterial = new THREE.LineBasicNodeMaterial();
  lineMaterial.positionNode = around(select(dot, 0.3, 1)).add(vec3(0, 0, sink.negate().add(g.z.mul(length))));
  const top = g.z.add(1); // 1 at the tops, 0 at the feet: posts fade into the dark
  const fade = smoothstep(radius.max(0.06).mul(2.5), radius.max(0.06).mul(4.5), d).oneMinus();
  // A faint ring sweeping out from the butterfly now and then.
  const ring = exp(d.sub(fract(time.mul(0.15)).mul(radius).mul(1.6)).div(0.004).pow(2).negate()).mul(0.8);
  lineMaterial.colorNode = mix(new THREE.Color(VOID), vec3(0.35, 0.75, 1).mul(ring.add(0.7)), top.mul(0.75).add(0.25).mul(fade).mul(exp(sink.mul(-8))));
  const columns = columnsGeometry();
  const lines = new THREE.LineSegments(columns, lineMaterial);
  lines.frustumCulled = false;
  const envLines = new THREE.LineSegments(columns, lineMaterial);

  // The filled tops: a dimmer, uneven blue just under the top edges; other columns' quads collapse.
  const faceMaterial = new THREE.MeshBasicNodeMaterial();
  faceMaterial.positionNode = around(select(filled, 1, 0)).add(vec3(0, 0, sink.negate().sub(0.0002)));
  const shade = hash(cell.x.mul(1597).add(cell.y.mul(2741))).mul(0.5).add(0.3);
  faceMaterial.colorNode = mix(new THREE.Color(VOID), vec3(0.2, 0.5, 0.8).mul(ring.add(0.7)).mul(shade), fade.mul(exp(sink.mul(-8))));
  const tops = facesGeometry();
  const faces = new THREE.Mesh(tops, faceMaterial);
  faces.frustumCulled = false;
  const envFaces = new THREE.Mesh(tops, faceMaterial);

  // Shadows on the platform: a surface that draws nothing but the shadow, over the lines behind it.
  const shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowNodeMaterial({ opacity: 0.7 }));
  shadowCatcher.receiveShadow = true;
  shadowCatcher.renderOrder = 1;
  const wall = new THREE.Group().add(lines, faces, shadowCatcher);

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
  const envWall = new THREE.Group().add(envLines, envFaces, envBehind);

  return { wall, space: specks, envWall, update };
}
