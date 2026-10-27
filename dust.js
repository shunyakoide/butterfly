import * as THREE from 'three/webgpu';
import { uniform, positionWorld, cameraPosition, instanceIndex, hash, time, sin, float } from 'three/tsl';

// Dust drifting in the air around the butterfly, seen only where the sun catches it. Each mote
// scatters sunlight with a Henyey-Greenstein phase function (g 0.65, est. for fine dust): bright
// looking toward the sun, faint across it, near nothing with the sun behind the camera, plus a
// little sky light. Motes are flat and turn as they drift, so each glints on and off. Most sit
// off the focal plane and the depth of field turns them into soft discs.

const COUNT = 600;
const BOX = new THREE.Vector3(0.3, 0.3, 0.16); // m, the volume kept filled around the butterfly
const G = 0.65;

export function buildDust(sunDir, sunColor) {
  const sun = uniform(sunDir), colour = uniform(sunColor);
  const toEye = cameraPosition.sub(positionWorld).normalize();
  const cos = sun.negate().dot(toEye); // scattering angle: light travels along -sunDir
  const phase = float(1 - G * G).div(float(1 + G * G).sub(cos.mul(2 * G)).pow(1.5)).mul(1 / (4 * Math.PI));
  const id = hash(instanceIndex.toFloat());
  const glint = sin(time.mul(id.mul(5).add(1.5)).add(id.mul(40))).abs().mul(0.75).add(0.25);
  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = colour.mul(phase.mul(3).add(0.05)).mul(glint);

  const mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), material, COUNT);
  mesh.frustumCulled = false;
  const r = Math.random;
  const motes = Array.from({ length: COUNT }, () => ({
    pos: new THREE.Vector3(r() - 0.5, r() - 0.5, r()).multiply(BOX),
    vel: new THREE.Vector3(),
    size: 0.0002 + 0.0004 * r(), // drawn larger than real dust (20-100 µm), which would be sub-pixel
  }));
  const centre = new THREE.Vector3(), m = new THREE.Matrix4(), p = new THREE.Vector3();

  function update(dt, target) {
    // The volume follows the butterfly loosely, so motes don't all slide along with it.
    centre.x = THREE.MathUtils.damp(centre.x, target.x, 0.5, dt);
    centre.y = THREE.MathUtils.damp(centre.y, target.y, 0.5, dt);
    for (let i = 0; i < COUNT; i++) {
      const d = motes[i];
      // Random walk in still air, damped, with a slow rise (est. a few mm/s of convection).
      d.vel.x += (r() - 0.5) * 0.02 * dt;
      d.vel.y += (r() - 0.5) * 0.02 * dt + 0.002 * dt;
      d.vel.z += (r() - 0.5) * 0.02 * dt;
      d.vel.multiplyScalar(Math.exp(-0.5 * dt));
      d.pos.addScaledVector(d.vel, dt);
      // Keep inside the box around the centre: x, y wrap; z stays off the wall.
      p.copy(d.pos).sub(centre);
      p.x = THREE.MathUtils.euclideanModulo(p.x + BOX.x / 2, BOX.x) - BOX.x / 2;
      p.y = THREE.MathUtils.euclideanModulo(p.y + BOX.y / 2, BOX.y) - BOX.y / 2;
      d.pos.set(centre.x + p.x, centre.y + p.y, THREE.MathUtils.euclideanModulo(d.pos.z - 0.003, BOX.z) + 0.003);
      mesh.setMatrixAt(i, m.makeScale(d.size, d.size, d.size).setPosition(d.pos));
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  return { mesh, update };
}
