import * as THREE from 'three/webgpu';
import { uniform, attribute, positionGeometry, time, smoothstep, mix, vec3, exp, fract, select } from 'three/tsl';

// A second wall, of circuitry: amber traces (a few teal) in layers that go back into the dark, with
// pads at their ends and beams running straight back from some of them. Pulses of light run along
// everything, and the traces under the butterfly glow while it rests there. All of it is one set of
// line segments, drawn additively so crossings glow, and built only where the fixed camera sees it.

const LAYERS = [0, -0.01, -0.03, -0.07, -0.15, -0.3, -0.6, -1.2]; // m, depth each layer of traces starts at
const TRACES = 70; // per layer: sparse, so most of the wall is dark
// Eight directions in turning order, so a turn is ±1 step around the ring.
const RING = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

// Where the frame (with a margin for the sway) meets the plane at depth z.
function footprint(camera, z) {
  const ray = new THREE.Raycaster(), plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -z), p = new THREE.Vector3();
  const box = new THREE.Box2();
  for (const [x, y] of [[-1.05, -1.05], [1.05, -1.05], [1.05, 1.05], [-1.05, 1.05]]) {
    ray.setFromCamera(new THREE.Vector2(x, y), camera);
    if (ray.ray.intersectPlane(plane, p)) box.expandByPoint(new THREE.Vector2(p.x, p.y));
  }
  return box;
}

// Per vertex: u, the distance along its trace (m), so pulses can run along it; seed, one random number
// per trace; kind, 0 for a trace, 1 for a pad, 2 for a beam.
function circuitGeometry(camera) {
  camera.updateMatrixWorld();
  const r = Math.random, pos = [], u = [], seed = [], kind = [];
  const seg = (a, b, u0, u1, s, k) => { pos.push(...a, ...b); u.push(u0, u1); seed.push(s, s); kind.push(k, k); };
  for (const z of LAYERS) {
    const box = footprint(camera, z);
    // The pitch grows with depth as fast as the view shrinks it (the camera is ~0.29 m away), so every
    // layer looks about as fine on screen.
    const g = 0.0025 * (0.29 - z) / 0.29;
    const snap = (v) => Math.round(v / g) * g;
    for (let t = 0; t < TRACES; t++) {
      const s = r();
      let x = snap(box.min.x + r() * (box.max.x - box.min.x)), y = snap(box.min.y + r() * (box.max.y - box.min.y));
      let dir = 2 * Math.floor(r() * 4), along = 0, zt = z;
      if (r() < 0.25) {
        const len = 0.2 + 3 * r() * r();
        seg([x, y, z], [x, y, z - len], 0, len, s, 2);
      }
      for (let n = 3 + Math.floor(r() * 10); n > 0; n--) {
        // Now and then the trace drops back a little, to carry on deeper: the circuit has thickness.
        if (r() < 0.12) {
          const dz = (4 + r() * 12) * g;
          seg([x, y, zt], [x, y, zt - dz], along, along + dz, s, 0);
          zt -= dz; along += dz;
        }
        if (r() < 0.35) dir = (dir + (r() < 0.5 ? 1 : 7)) % 8;
        const [dx, dy] = RING[dir], len = (1 + Math.floor(r() * 5)) * g;
        const step = len * Math.hypot(dx, dy);
        seg([x, y, zt], [x + dx * len, y + dy * len, zt], along, along + step, s, 0);
        x += dx * len; y += dy * len; along += step;
      }
      const a = g * 0.4;
      seg([x - a, y, zt], [x + a, y, zt], along, along, s, 1);
      seg([x, y - a, zt], [x, y + a, zt], along, along, s, 1);
    }
  }
  return new THREE.BufferGeometry()
    .setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    .setAttribute('u', new THREE.Float32BufferAttribute(u, 1))
    .setAttribute('seed', new THREE.Float32BufferAttribute(seed, 1))
    .setAttribute('kind', new THREE.Float32BufferAttribute(kind, 1));
}

export function buildCircuit(camera) {
  const centre = uniform(new THREE.Vector2()), radius = uniform(0);
  const u = attribute('u', 'float'), seed = attribute('seed', 'float'), kind = attribute('kind', 'float');
  const p = positionGeometry;
  // Pulses differ from trace to trace: 2.5-17 cm apart, from short bright sparks to long dim streaks
  // (a bright head with a fading tail), and from a crawl to a dash (0.3-8 pulses a second). Bright
  // enough (>1) for the bloom.
  const s1 = fract(seed.mul(13.17)), s2 = fract(seed.mul(71.3)), s3 = fract(seed.mul(37.9));
  const tail = mix(0.4, 0.97, s2);
  const wave = fract(u.mul(mix(6, 40, s1)).sub(time.mul(s3.pow(3).mul(8).add(0.3))).add(seed.mul(10)));
  const pulse = smoothstep(tail, 1, wave).mul(mix(1.5, 6, s2));
  const pad = select(kind.equal(1), 1.2, 0);
  // Under the resting butterfly the traces glow, as if it were drawing power from them.
  const hot = exp(p.xy.sub(centre).length().div(0.04).pow(2).negate()).mul(radius.div(0.12)).mul(2);
  // Dimmer with depth; beams fade more slowly, so they reach far back.
  const depthFade = exp(p.z.mul(select(kind.equal(2), 0.8, 2)));
  const tint = select(seed.greaterThan(0.85), vec3(0.3, 1, 0.7), vec3(1, 0.55, 0.18));
  const material = new THREE.LineBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  material.colorNode = tint.mul(pulse.add(s1.mul(0.12).add(0.03)).add(pad).add(hot).mul(depthFade));

  const lines = new THREE.LineSegments(undefined, material);
  lines.frustumCulled = false;
  const envLines = new THREE.LineSegments(undefined, material);
  // Rebuilt when the frame changes shape.
  function fit() {
    lines.geometry.dispose();
    envLines.geometry = lines.geometry = circuitGeometry(camera);
  }
  fit();

  function update(cx, cy, rad) {
    centre.value.set(cx, cy);
    radius.value = rad;
  }
  return { wall: lines, envWall: envLines, update, fit };
}
