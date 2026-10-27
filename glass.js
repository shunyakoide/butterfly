import * as THREE from 'three/webgpu';
import { uniform, attribute, positionGeometry, normalView, positionViewDirection, time, smoothstep, mix, vec3, exp, fract, sin } from 'three/tsl';
import { footprint } from './circuit.js';

// A third wall: the face of a crystal block, in silver and white. Glass tiles make the face the
// butterfly stands on; behind them glass boxes of every size and a few dark solid blocks go back
// into the dark, threaded with white maze-like lines that pulses run along. Some tiles and boxes
// slide slowly in and out. The glass is faked to stay cheap: faces drawn additively, brighter
// where seen edge-on, with lit edges, instead of real refraction.

const TILE = 0.012; // m, pitch of the glass tiles on the face
const LAYERS = [-0.02, -0.05, -0.1, -0.18, -0.32]; // m, depth of each layer of boxes behind the face
const BOXES = 45;  // per layer
const TRACES = 30; // maze lines per layer

// Boxes as faces and edges, each vertex carrying its box's centre (so the shader can tell how far it
// is from the butterfly), how far the box slides back (m) and a phase, plus whether it is solid.
function blockGeometry(camera) {
  camera.updateMatrixWorld();
  const r = Math.random;
  const glass = { pos: [], nrm: [], centre: [], slide: [], phase: [] };
  const solid = { pos: [], nrm: [], centre: [], slide: [], phase: [] };
  const edges = { pos: [], centre: [], slide: [], phase: [] };
  const box = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
  const bp = box.attributes.position.array, bn = box.attributes.normal.array;
  const corners = [];
  for (let i = 0; i < 8; i++) corners.push([(i & 1) - 0.5, ((i >> 1) & 1) - 0.5, ((i >> 2) & 1) - 0.5]);
  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  function add(target, cx, cy, cz, sx, sy, sz, slide, phase) {
    for (let i = 0; i < bp.length; i += 3) {
      target.pos.push(cx + bp[i] * sx, cy + bp[i + 1] * sy, cz + bp[i + 2] * sz);
      target.nrm.push(bn[i], bn[i + 1], bn[i + 2]);
      target.centre.push(cx, cy); target.slide.push(slide); target.phase.push(phase);
    }
    for (const [a, b] of EDGES) for (const k of [a, b]) {
      const c = corners[k];
      edges.pos.push(cx + c[0] * sx, cy + c[1] * sy, cz + c[2] * sz);
      edges.centre.push(cx, cy); edges.slide.push(slide); edges.phase.push(phase);
    }
  }
  // The face: tiles 3 mm thick, flush at z = 0; a third of them slide back up to 2 cm, now and then.
  const front = footprint(camera, 0);
  for (let x = Math.floor(front.min.x / TILE) * TILE; x < front.max.x; x += TILE) {
    for (let y = Math.floor(front.min.y / TILE) * TILE; y < front.max.y; y += TILE) {
      if (r() < 0.08) continue; // a few missing
      add(glass, x + TILE / 2, y + TILE / 2, -0.0015, TILE * 0.94, TILE * 0.94, 0.003, r() < 0.33 ? 0.02 * r() : 0, r());
    }
  }
  // Behind: boxes on a pitch that grows with depth as the view shrinks it, some solid.
  for (const z of LAYERS) {
    const fp = footprint(camera, z), g = 0.008 * (0.29 - z) / 0.29;
    for (let n = 0; n < BOXES; n++) {
      const sx = (1 + Math.floor(r() * 6)) * g, sy = (1 + Math.floor(r() * 6)) * g, sz = (1 + Math.floor(r() * 8)) * g;
      const cx = fp.min.x + r() * (fp.max.x - fp.min.x), cy = fp.min.y + r() * (fp.max.y - fp.min.y);
      add(r() < 0.15 ? solid : glass, cx, cy, z - sz / 2, sx, sy, sz, 0.03 * r(), r());
    }
  }
  const make = (t) => {
    const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(t.pos, 3));
    if (t.nrm) geo.setAttribute('normal', new THREE.Float32BufferAttribute(t.nrm, 3));
    return geo.setAttribute('centre', new THREE.Float32BufferAttribute(t.centre, 2))
      .setAttribute('slide', new THREE.Float32BufferAttribute(t.slide, 1))
      .setAttribute('phase', new THREE.Float32BufferAttribute(t.phase, 1));
  };
  return { glass: make(glass), solid: make(solid), edges: make(edges) };
}

// Maze lines inside the block: walks along x, y and z on a grid, with u, the distance along each.
function mazeGeometry(camera) {
  const r = Math.random, pos = [], u = [], seed = [];
  const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, -1], [0, 0, 1]];
  for (const z0 of LAYERS) {
    const fp = footprint(camera, z0), g = 0.004 * (0.29 - z0) / 0.29;
    for (let t = 0; t < TRACES; t++) {
      const s = r();
      let p = [fp.min.x + r() * (fp.max.x - fp.min.x), fp.min.y + r() * (fp.max.y - fp.min.y), z0], along = 0;
      for (let n = 4 + Math.floor(r() * 10); n > 0; n--) {
        const d = DIRS[Math.floor(r() * 6)], len = (1 + Math.floor(r() * 4)) * g;
        const q = [p[0] + d[0] * len, p[1] + d[1] * len, Math.min(-0.006, p[2] + d[2] * len)];
        pos.push(...p, ...q); u.push(along, along + len); seed.push(s, s);
        p = q; along += len;
      }
    }
  }
  return new THREE.BufferGeometry()
    .setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    .setAttribute('u', new THREE.Float32BufferAttribute(u, 1))
    .setAttribute('seed', new THREE.Float32BufferAttribute(seed, 1));
}

export function buildGlass(camera) {
  const centre = uniform(new THREE.Vector2()), radius = uniform(0);
  const TINT = vec3(0.75, 0.88, 0.95); // silver with a breath of cyan

  // Shared by faces and edges: each box slides back and forth on its own slow cycle, except where the
  // butterfly stands, which stays put.
  const boxCentre = attribute('centre', 'vec2'), slide = attribute('slide', 'float'), phase = attribute('phase', 'float');
  const d = boxCentre.sub(centre).length();
  const still = smoothstep(radius.mul(0.25), radius.mul(0.6).add(0.001), d);
  const back = slide.mul(sin(time.mul(0.35).add(phase.mul(6.283))).mul(0.5).add(0.5)).mul(still);
  const placed = positionGeometry.sub(vec3(0, 0, back));
  // Dimmer with depth; brighter right around the resting butterfly.
  const depthFade = exp(placed.z.mul(4));
  const near = exp(d.div(0.035).pow(2).negate()).mul(radius.div(0.12));

  const faceMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  faceMat.positionNode = placed;
  const edgeOn = normalView.dot(positionViewDirection).abs().oneMinus().pow(3);
  faceMat.colorNode = TINT.mul(edgeOn.mul(0.12).add(0.005)).mul(depthFade).mul(near.mul(2).add(1));

  const solidMat = new THREE.MeshStandardNodeMaterial({ color: 0x1a1d20, roughness: 0.35, metalness: 0.6 });
  solidMat.positionNode = placed;

  // Edges write depth, so the depth of field blurs the deep ones.
  const edgeMat = new THREE.LineBasicNodeMaterial({ transparent: true, blending: THREE.AdditiveBlending });
  edgeMat.positionNode = placed;
  edgeMat.colorNode = TINT.mul(0.16).mul(depthFade).mul(near.mul(3).add(1));

  const u = attribute('u', 'float'), seed = attribute('seed', 'float');
  const pulse = smoothstep(0.85, 1, fract(u.mul(8).sub(time.mul(seed.mul(0.6).add(0.15))).add(seed.mul(10)))).mul(2.5);
  const mazeMat = new THREE.LineBasicNodeMaterial({ transparent: true, blending: THREE.AdditiveBlending });
  mazeMat.colorNode = TINT.mul(pulse.add(0.08)).mul(exp(positionGeometry.z.mul(3)));

  const glass = new THREE.Mesh(undefined, faceMat), solid = new THREE.Mesh(undefined, solidMat);
  const edges = new THREE.LineSegments(undefined, edgeMat), maze = new THREE.LineSegments(undefined, mazeMat);
  solid.receiveShadow = true;
  for (const o of [glass, solid, edges, maze]) o.frustumCulled = false;
  const wall = new THREE.Group().add(solid, glass, edges, maze);
  const envSolid = new THREE.Mesh(undefined, solidMat), envEdges = new THREE.LineSegments(undefined, edgeMat);
  const envWall = new THREE.Group().add(envSolid, envEdges);

  // Rebuilt when the frame changes shape.
  function fit() {
    for (const o of [glass, solid, edges, maze]) o.geometry.dispose();
    const b = blockGeometry(camera);
    glass.geometry = b.glass;
    envSolid.geometry = solid.geometry = b.solid;
    envEdges.geometry = edges.geometry = b.edges;
    maze.geometry = mazeGeometry(camera);
  }
  fit();

  function update(cx, cy, rad) {
    centre.value.set(cx, cy);
    radius.value = rad;
  }
  return { wall, envWall, update, fit };
}
