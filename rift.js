import * as THREE from 'three/webgpu';
import { attribute, positionGeometry, time, smoothstep, mix, vec3, exp, fract, floor, hash, select } from 'three/tsl';

// Only the butterfly is real. It stands on a wall built of lines: square columns drawn as
// outlines, their tops level only under the butterfly's feet and, all around, at scattered depths
// that keep changing, sinking away into a dark space that goes on without end, where specks of light
// drift. The columns are placed in the vertex shader, so the platform forms wherever the butterfly
// is; when it leaves, the whole wall sinks, and rises again when it returns. The lines glow (the
// only light back there), the butterfly's shadow still falls on the platform, and both reach the
// butterfly through its environment capture.

export const VOID = 0x010103; // the colour of the space behind
const SPAN = 1.0;   // m, extent of the wall searched for visible columns
const CELL = 0.005; // m, column pitch; each column is drawn 84% of it wide, so they read apart
const DEEPEST = 0.3;  // m, how far back a column's foot can reach (sink + post length, below)
// m, full radius of the platform under the resting butterfly; main.js grows it after touchdown, and the circuit and glass walls scale their glow by it (est.)
export const PLATFORM = 0.12;

// The camera never moves, so only columns that show in it are built: a column is kept when the box
// spanned by its top and its deepest foot, on screen, overlaps the frame (with a small margin).
function visibleCells(camera) {
  camera.updateMatrixWorld();
  const n = Math.round(SPAN / CELL), h0 = -SPAN / 2, p = new THREE.Vector3(), cells = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const cx = h0 + (i + 0.5) * CELL, cy = h0 + (j + 0.5) * CELL;
      const a = p.set(cx, cy, 0).project(camera).clone(), b = p.set(cx, cy, -DEEPEST).project(camera);
      if (Math.max(a.x, b.x) > -1.05 && Math.min(a.x, b.x) < 1.05 && Math.max(a.y, b.y) > -1.05 && Math.min(a.y, b.y) < 1.05) cells.push(cx, cy);
    }
  }
  return cells;
}

// Per column, z 0 at the top and -1 at the foot (the shader places it): faces, one quad over its top,
// for the columns drawn filled; columns, as lines, the 4 edges of its top and its 4 corner posts.
function columnGeometry(cells) {
  const a = CELL * 0.42, corners = [[-a, -a], [a, -a], [a, a], [-a, a]];
  const faces = { pos: [], cell: [] }, columns = { pos: [], cell: [] };
  const put = (t, cx, cy, [x, y], z = 0) => { t.pos.push(cx + x, cy + y, z); t.cell.push(cx, cy); };
  for (let c = 0; c < cells.length; c += 2) {
    const cx = cells[c], cy = cells[c + 1];
    for (const k of [0, 1, 2, 0, 2, 3]) put(faces, cx, cy, corners[k]);
    for (let k = 0; k < 4; k++) {
      const c0 = corners[k], c1 = corners[(k + 1) % 4];
      put(columns, cx, cy, c0); put(columns, cx, cy, c1); put(columns, cx, cy, c0); put(columns, cx, cy, c0, -1);
    }
  }
  const make = (t) => new THREE.BufferGeometry()
    .setAttribute('position', new THREE.Float32BufferAttribute(t.pos, 3))
    .setAttribute('cell', new THREE.Float32BufferAttribute(t.cell, 2));
  return { faces: make(faces), columns: make(columns) };
}

// The columns stand where the feet are: centre and radius are the uniforms main.js shares with every wall.
export function buildRift(camera, { centre, radius }) {
  // ---------- the wall of lines ----------
  const cell = attribute('cell', 'vec2'), g = positionGeometry;
  const d = cell.sub(centre).length();
  // hash() truncates its seed to an unsigned integer (negatives become 0), so seed it with the column's
  // grid index, counted from the wall's corner.
  const ij = cell.add(SPAN / 2).div(CELL).floor(), key = ij.x.add(ij.y.mul(1024));
  const h = hash(key);
  // 0 on the platform, 1 well away from it (or everywhere, while the butterfly is away).
  const drop = smoothstep(radius.mul(0.2), radius.mul(0.6).add(0.001), d);
  // Under the feet the tops jitter by ~1 mm; elsewhere each column holds a depth of 2-27 cm for a few
  // seconds, then slides to a new one, on its own schedule, so the wall never settles.
  const phase = time.mul(0.15).add(h.mul(7));
  const depth = mix(hash(key.add(fract(floor(phase).mul(0.618)).mul(1e7))), hash(key.add(fract(floor(phase).add(1).mul(0.618)).mul(1e7))), smoothstep(0.6, 1, fract(phase)));
  const sink = mix(h.mul(0.0015), depth.mul(depth).mul(0.25).add(0.02), drop);
  const length = mix(0.004, 0.012, drop); // m, how far each column's posts reach back
  // Mixed looks: ~70% of columns are outlines, ~20% filled blocks, ~10% shrunk to a pixel-like dot.
  const style = hash(key.add(300000));
  const filled = style.lessThan(0.2), dot = style.greaterThan(0.9);
  const around = (k) => vec3(cell.x.add(g.x.sub(cell.x).mul(k)), cell.y.add(g.y.sub(cell.y).mul(k)), 0);
  // Opaque, so nearer lines hide farther ones: added up, the platform blew out to white at grazing angles.
  const lineMaterial = new THREE.LineBasicNodeMaterial();
  lineMaterial.positionNode = around(select(dot, 0.3, 1)).add(vec3(0, 0, sink.negate().add(g.z.mul(length))));
  const top = g.z.add(1); // 1 at the tops, 0 at the feet: posts fade into the dark
  // A faint ring sweeping out from the butterfly now and then.
  const ring = exp(d.sub(fract(time.mul(0.15)).mul(radius).mul(1.6)).div(0.004).pow(2).negate()).mul(0.8);
  lineMaterial.colorNode = mix(new THREE.Color(VOID), vec3(0.35, 0.75, 1).mul(ring.add(0.7)), top.mul(0.75).add(0.25).mul(exp(sink.mul(-8))));
  const lines = new THREE.LineSegments(undefined, lineMaterial);
  lines.frustumCulled = false;
  const envLines = new THREE.LineSegments(undefined, lineMaterial);

  // The filled tops: a dimmer, uneven blue just under the top edges; other columns' quads collapse.
  const faceMaterial = new THREE.MeshBasicNodeMaterial();
  faceMaterial.positionNode = around(select(filled, 1, 0)).add(vec3(0, 0, sink.negate().sub(0.0002)));
  const shade = hash(key.add(600000)).mul(0.5).add(0.3);
  faceMaterial.colorNode = mix(new THREE.Color(VOID), vec3(0.2, 0.5, 0.8).mul(ring.add(0.7)).mul(shade), exp(sink.mul(-8)));
  const faces = new THREE.Mesh(undefined, faceMaterial);
  faces.frustumCulled = false;
  const envFaces = new THREE.Mesh(undefined, faceMaterial);
  // Rebuilt when the frame changes shape.
  function fit() {
    lines.geometry.dispose();
    faces.geometry.dispose();
    const b = columnGeometry(visibleCells(camera));
    envLines.geometry = lines.geometry = b.columns;
    envFaces.geometry = faces.geometry = b.faces;
  }
  fit();

  return { wall: new THREE.Group().add(lines, faces), envWall: new THREE.Group().add(envLines, envFaces), fit };
}

// Shared by every wall: the shadow under the butterfly, the specks in the space behind and, for the
// environment capture, the dark behind the wall.
export function buildSpace({ centre, radius }) {
  // Shadows on the platform: a surface that draws nothing but the shadow, over the lines behind it.
  const shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowNodeMaterial({ opacity: 0.7 }));
  shadowCatcher.receiveShadow = true;
  shadowCatcher.renderOrder = 1;

  // The space behind: nothing is drawn for it, as the camera always faces the wall, so the scene
  // background (set to VOID in main.js) is all that shows. Depth comes from specks drifting slowly
  // away, shrinking below a pixel long before they stop.
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

  function update(dt) {
    shadowCatcher.position.set(centre.value.x, centre.value.y, 0);
    shadowCatcher.scale.setScalar(Math.max(radius.value * 2.6, 1e-6));
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

  return { group: new THREE.Group().add(shadowCatcher, specks), specks, envBehind, update };
}
