import * as THREE from 'three/webgpu';
import { pass, uniform, vec2, vec4, float, smoothstep, screenUV } from 'three/tsl';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { chromaticAberration } from 'three/addons/tsl/display/ChromaticAberrationNode.js';
import { film } from 'three/addons/tsl/display/FilmNode.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Butterfly, REST_HEIGHT } from './butterfly.js';
import { morphoPattern, mutatePattern } from './pattern.js';
import { buildRift, VOID } from './rift.js';

// Units are meters. The wall is the z = 0 plane, facing +z.
const HDRI = 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/garden_nook_2k.hdr';
const deg = THREE.MathUtils.degToRad;
const hud = document.getElementById('hud');

const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 0.75;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // WebGPU has no PCFSoft; shadow.radius softens
document.body.appendChild(renderer.domElement);
await renderer.init();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.01, 60); // far: the space behind the wall
camera.position.set(0.1, -0.12, 0.25);
camera.lookAt(0, 0.005, 0);

// ---------- wall: lines around the butterfly, and the space behind (rift.js) ----------

const rift = buildRift();
scene.add(rift.wall, rift.space);
// Where the wall was: 1.6 m square, for picking points on it (most of it is no longer drawn).
const wallPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
function onWall() {
  const p = ray.ray.intersectPlane(wallPlane, new THREE.Vector3());
  return p && Math.abs(p.x) < 0.8 && Math.abs(p.y) < 0.8 ? p : null;
}

// ---------- light ----------

// 2.6 is ~6.4x the HDRI sky's irradiance on a horizontal surface (0.905 x ENV): within a clear day's
// direct/diffuse ratio of ~5-10, so sun and sky agree with no clipped HDRI sun to measure against.
const sun = new THREE.DirectionalLight(0xfff0dc, 2.6);
// From the side, opposite the camera (az -65°, el 40°): the blue gets the oblique light that whitens
// one side, and the shadow falls long across the platform.
sun.position.set(Math.sin(deg(-65)) * Math.cos(deg(40)), Math.sin(deg(40)), Math.cos(deg(-65)) * Math.cos(deg(40)));
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -0.25, right: 0.25, top: 0.25, bottom: -0.25, near: 0.05, far: 2 });
sun.shadow.bias = -0.0002;
sun.shadow.normalBias = 0.0005;
sun.shadow.radius = 3;
scene.add(sun, sun.target);
// The shadow camera covers only ±25 cm, so the light follows the butterfly (see the loop).
const sunDir = sun.position.clone().normalize();

// ---------- environment: the garden HDRI as seen from the butterfly, wall included ----------

// The HDRI's sun is clipped at the half-float max (65504) and sits in another direction from our
// shadow-casting sun: left in, it lights the butterfly a second time, shadowless. Scale it (and its
// aureole) down to the brightest sky (99.9th percentile ~3.3) and return its azimuth, measured
// like sunAngles.az, so the sky can be turned to put its bright side behind our sun.
function removeSun(tex, cap = 4) {
  console.assert(tex.type === THREE.HalfFloatType);
  const { data, width } = tex.image, { fromHalfFloat: f, toHalfFloat: h } = THREE.DataUtils;
  let best = 0, at = 0;
  for (let i = 0; i < data.length; i += 4) {
    const c = [0, 1, 2].map((k) => Math.min(f(data[i + k]), 65504)); // clipped texels may be Inf
    const L = (c[0] + c[1] + c[2]) / 3;
    if (L > best) { best = L; at = i / 4; }
    if (L > cap) for (let k = 0; k < 3; k++) data[i + k] = h(c[k] * cap / L);
  }
  tex.needsUpdate = true;
  const a = ((at % width) / width - 0.5) * 2 * Math.PI; // equirect u -> atan2(z, x)
  return Math.atan2(Math.cos(a), Math.sin(a));
}
const hdr = await new HDRLoader().loadAsync(HDRI);
hdr.mapping = THREE.EquirectangularReflectionMapping;
const hdrSunAz = removeSun(hdr);
const ENV = 0.45;
// Everything the camera sees past the wall is the space behind it (see rift.js).
scene.background = new THREE.Color(VOID);
scene.environmentIntensity = ENV;

// The butterfly sits a few mm from the wall: the sky is only in front, behind is dark but for the
// glowing lines. So its environment is captured from where it is, in a scene with just the sky and
// the line wall.
const pmrem = new THREE.PMREMGenerator(renderer);
const envScene = new THREE.Scene();
envScene.background = hdr;
envScene.add(rift.envWall);
let envTarget = null;
function captureEnvironment(pos) {
  const rot = sunAngles.az - hdrSunAz;
  envScene.backgroundRotation.y = rot;
  envTarget = pmrem.fromScene(envScene, 0, 0.001, 40, { size: 128, position: pos, renderTarget: envTarget });
  scene.environment = envTarget.texture;
}

// ---------- post: shallow macro depth of field, and the lens ----------

const pipeline = new THREE.RenderPipeline(renderer);
const scenePass = pass(scene, camera, { samples: 4 });
const focus = uniform(camera.position.length());
const sharp = dof(scenePass.getTextureNode(), scenePass.getViewZNode(), focus, uniform(0.03), uniform(2));
// What a real lens and sensor add, so the frame reads as photographed: glow around the bright lines
// and highlights, a little colour fringing toward the corners, darker corners, and fine grain.
const glowing = sharp.add(bloom(sharp, 0.2, 0.3, 1.1)); // threshold above the lit wings, so only highlights and lines glow
const fringed = chromaticAberration(glowing, 0.2, vec2(0.5, 0.5), 1.0);
const vignette = smoothstep(0.35, 0.95, screenUV.sub(0.5).length().mul(1.4)).mul(0.45).oneMinus();
pipeline.outputNode = film(vec4(fringed.rgb.mul(vignette), 1), float(0.12));

// ---------- butterfly behaviour ----------

// ?wear=0..1 overrides the random wear, for checking old, worn individuals.
const params = new URLSearchParams(location.search);
const wearParam = params.get('wear');
const bf = new Butterfly({ ...morphoPattern(), ...(wearParam && { wear: +wearParam }) });
scene.add(bf.group);

const WALL_N = new THREE.Vector3(0, 0, 1);
const UP = new THREE.Vector3(0, 1, 0);
const rand = THREE.MathUtils.randFloat;
const pose = params.get('pose');
// Wing roots sit a thorax-width apart, so closed wings lean slightly past vertical to meet at the tips.
const CLOSED = deg(91.5);

function basis(forward, dorsal) {
  const right = new THREE.Vector3().crossVectors(forward, dorsal).normalize();
  const d = new THREE.Vector3().crossVectors(right, forward).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, forward, d));
}
function restPose(x, y, heading) {
  return {
    pos: new THREE.Vector3(x, y, REST_HEIGHT),
    quat: basis(new THREE.Vector3(Math.cos(heading), Math.sin(heading), 0), WALL_N),
  };
}
// Points chosen through the current view, so the flight crosses the frame wherever the camera is.
function throughView(x, y, off) {
  ray.setFromCamera(new THREE.Vector2(x, y), camera);
  const hit = onWall();
  return hit ? hit.addScaledVector(WALL_N, off) : ray.ray.at(0.4, new THREE.Vector3());
}
// Just outside the frame, to one side or the top.
function offscreenPoint() {
  const side = [[-1.6, rand(-0.5, 0.8)], [1.6, rand(-0.5, 0.8)], [rand(-0.8, 0.8), 1.6]][Math.floor(Math.random() * 3)];
  return throughView(side[0], side[1], rand(0.06, 0.15));
}
// A few cm off the wall, inside the frame.
function wanderPoint() {
  return throughView(rand(-0.6, 0.6), rand(-0.4, 0.6), rand(0.03, 0.08));
}

const state = {
  mode: 'rest',
  rest: restPose(0, 0, deg(80)),
  curve: null, s: 0, dist: 0, length: 1, speed: 1,
  phase: 0, timer: 0, flapping: 1, flap: 1, bout: 3, glide: 0, alt: 0,
  restAngle: deg(10), restTarget: deg(10), restSwitch: rand(5, 10), lean: 0, leanTarget: deg(rand(-6, 6)),
};
bf.group.position.copy(state.rest.pos);
bf.group.quaternion.copy(state.rest.quat);

function startJourney(mode, points, speed) {
  state.mode = mode;
  state.curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  state.length = state.curve.getLength();
  state.speed = speed;
  state.dist = 0;
  state.s = 0;
  Object.assign(state, { t: 0, kick: 0, kickNow: 0, bank: 0, lastPos: null, vel: null, prevVel: null,
    wobble: [0, 1, 2, 3].map(() => Math.random() * Math.PI * 2) });
}

// Flight kinematics of M. helenor (which includes peleides), from Le Roy et al. 2019
// (doi:10.1242/jeb.204057), 2022 (doi:10.1242/jeb.243867) and the 2021 gliding preprint
// (doi:10.1101/2021.03.22.436469). Values marked "est." were not found and are set by eye.
const BEAT_HZ = 5.9;                 // free flight, ±1.7
const STROKE_TOP = deg(88);          // wings (nearly) clap above the back
const STROKE_AMP = deg(128);         // forewing amplitude, understory species
const HIND_LAG = 0.12;               // rad of phase; fore and hind wings move nearly together
const TWIST = deg(15);               // est.: pronation on the downstroke, supination on the upstroke
const SPEED = 1.3;                   // m/s, climbing escape flight
const CLIMB = Math.tan(deg(13));     // path slope while flapping
const SINK = Math.tan(deg(11));      // glide slope
const GLIDE_WINGS = deg(12);         // est.: slight dihedral while gliding
const PITCH = deg(44);               // body pitch, climbing flight
const BOB = 0.003;                   // est.: body heave per wingbeat (m)
const START_SPEED = 0.2;             // est.: speed off the leg push, and at touchdown
// Path irregularity: no turning rates or sinuosity values were found for Morpho. Understory species
// fly fairly straight and fast (Le Roy 2021), so the meander is kept moderate (sinuosity ~1.15).
const WANDER = 0.025;                // est.: meander off the planned path (m), sideways and up/down
const KICK = 0.02;                   // est.: sideways jink at the start of each flapping bout (m)
const MAX_BANK = deg(40);            // est.: roll limit in turns

function takeOff() {
  const p = state.rest.pos;
  // The legs push off first, so the body leaves the wall before the wings give much lift.
  startJourney('takeoff', [
    p.clone(),
    p.clone().addScaledVector(WALL_N, 0.03).add(new THREE.Vector3(0, 0.012, 0)),
    wanderPoint(),
    offscreenPoint(),
  ], SPEED);
  // The first downstroke starts with the wings at the top (from closed, a fling).
  Object.assign(state, { phase: 0, flapping: 1, bout: 3, alt: 0 });
}

function comeBack() {
  bf.pattern = mutatePattern(bf.pattern);
  bf.paint();
  // Land somewhere inside the middle of the current view, whatever the aspect ratio.
  ray.setFromCamera(new THREE.Vector2(rand(-0.5, 0.5), rand(-0.45, 0.45)), camera);
  const spot = onWall();
  state.rest = restPose(spot.x, spot.y, deg(rand(40, 140)));
  const p = state.rest.pos;
  startJourney('landing', [
    offscreenPoint(),
    wanderPoint(),
    p.clone().addScaledVector(WALL_N, 0.045).add(new THREE.Vector3(rand(-0.02, 0.02), 0.015, 0)),
    p.clone(),
  ], SPEED * 0.8);
  // After touchdown the wings fold up closed.
  Object.assign(state, { flapping: 1, bout: 4, alt: 0, restAngle: CLOSED, restTarget: CLOSED, restSwitch: rand(0.8, 1.5) });
}

const tmpQ = new THREE.Quaternion();
const X_AXIS = new THREE.Vector3(1, 0, 0);
function fly(dt) {
  // Slow near the wall, full speed in the open: speeding up over the first ~12 cm after the leg
  // push, slowing over the last ~12 cm before touchdown. (At this macro framing, 1.3 m/s crosses
  // the frame in a tenth of a second.)
  const fromWall = state.mode === 'takeoff' ? state.dist : state.length - state.dist;
  const v = THREE.MathUtils.lerp(START_SPEED, state.speed, THREE.MathUtils.smoothstep(fromWall, 0, 0.12));
  state.dist = Math.min(state.length, state.dist + v * dt);
  const s = state.s = state.dist / state.length;
  const u = s;
  const pos = state.curve.getPointAt(u);
  const tangent = state.curve.getTangentAt(Math.min(u, 0.999));

  // How "airborne" we are: 0 standing on the wall, 1 in free flight.
  const air = state.mode === 'takeoff'
    ? THREE.MathUtils.smoothstep(s, 0, 0.06)
    : 1 - THREE.MathUtils.smoothstep(s, 0.85, 1);
  // Gliding only in free flight, away from the wall.
  const free = state.mode === 'takeoff' ? THREE.MathUtils.smoothstep(s, 0.2, 0.35) : 1 - THREE.MathUtils.smoothstep(s, 0.6, 0.75);

  // Flap–glide: bouts of a few wingbeats, then a short glide (≥0.17 s) with the wings held out.
  const prev = state.phase;
  if (state.flapping > 0.5 || state.phase % (Math.PI * 2) > 0.3) state.phase += dt * Math.PI * 2 * BEAT_HZ;
  if (Math.floor(state.phase / (Math.PI * 2)) > Math.floor(prev / (Math.PI * 2))) {
    // A wingbeat just finished, at the top of the stroke.
    if (state.flapping > 0.5 && --state.bout <= 0 && free > 0.9 && Math.random() < 0.6) {
      state.flapping = 0;
      // Understory Morpho (helenor/peleides) flap strongly with short glides (Le Roy 2021).
      state.glide = rand(0.17, 0.35);
    }
  }
  if (state.flapping < 0.5) {
    state.glide -= dt;
    if (state.glide <= 0 || free < 0.9) {
      // Each new bout sets off in a slightly different direction: the zigzag of the path.
      Object.assign(state, { flapping: 1, bout: 2 + Math.floor(Math.random() * 4), kick: rand(-1, 1) * KICK });
    }
  }
  // Ease between the two so the wings settle into the glide instead of snapping.
  state.flap = THREE.MathUtils.damp(state.flap ?? 1, state.flapping, 12, dt);

  const stroke = (ph) => STROKE_TOP - STROKE_AMP * (0.5 - 0.5 * Math.cos(ph));
  const fore = THREE.MathUtils.lerp(GLIDE_WINGS, stroke(state.phase), state.flap);
  const hind = THREE.MathUtils.lerp(GLIDE_WINGS, stroke(state.phase - HIND_LAG), state.flap);
  const twist = -TWIST * Math.sin(state.phase) * state.flap;
  bf.setWings(THREE.MathUtils.lerp(state.restAngle, fore, air), THREE.MathUtils.lerp(state.restAngle, hind, air), twist * air, state.lean * (1 - air));

  // Climb while flapping, sink while gliding; the offset returns to the path near the wall.
  state.alt += (state.flapping > 0.5 ? CLIMB : -SINK) * SPEED * dt * free;
  state.alt = THREE.MathUtils.clamp(state.alt, -0.03, 0.03) * (0.4 + 0.6 * free);
  // Each downstroke heaves the body: lowest mid-downstroke, when lift peaks (est. amplitude).
  pos.y += (state.alt - BOB * Math.sin(state.phase) * state.flap) * air;
  // Irregular path: slow meander sideways and up/down (sums of incommensurate sines), plus the
  // per-bout jink, away from the wall only.
  state.t = (state.t ?? 0) + dt;
  state.kickNow = THREE.MathUtils.damp(state.kickNow ?? 0, state.kick ?? 0, 4, dt);
  const t = state.t, w = state.wobble;
  const side = new THREE.Vector3().crossVectors(tangent, UP).normalize();
  const lat = WANDER * (0.6 * Math.sin(t * 5.1 + w[0]) + 0.4 * Math.sin(t * 8.3 + w[1])) + state.kickNow;
  const vert = WANDER * 0.7 * (0.6 * Math.sin(t * 4.3 + w[2]) + 0.4 * Math.sin(t * 9.7 + w[3]));
  pos.addScaledVector(side, lat * free).addScaledVector(UP, vert * free);
  // Heading follows where the body actually goes, not the planned path.
  const vel = state.lastPos ? pos.clone().sub(state.lastPos).divideScalar(Math.max(dt, 1e-4)) : tangent.clone();
  state.lastPos = pos.clone();
  state.vel = state.vel ? state.vel.lerp(vel, 1 - Math.exp(-15 * dt)) : vel;
  bf.group.position.copy(pos);

  // Body pitched up in flight, rocking with each beat; more nose-up while braking to land.
  const brake = state.mode === 'landing' ? THREE.MathUtils.smoothstep(s, 0.7, 0.95) : 0;
  const pitch = THREE.MathUtils.lerp(deg(15), PITCH, state.flap) + deg(20) * brake + deg(8) * Math.sin(state.phase) * state.flap;
  const heading = state.vel.lengthSq() > 0.01 ? state.vel.clone().normalize() : tangent;
  // Bank into turns: roll from the sideways acceleration, as for any flier (a = v·dθ/dt).
  const accel = state.prevVel ? state.vel.clone().sub(state.prevVel).divideScalar(Math.max(dt, 1e-4)) : new THREE.Vector3();
  state.prevVel = state.vel.clone();
  const bankTarget = THREE.MathUtils.clamp(Math.atan2(accel.dot(new THREE.Vector3().crossVectors(heading, UP).normalize()), 9.8), -MAX_BANK, MAX_BANK);
  state.bank = THREE.MathUtils.damp(state.bank ?? 0, bankTarget * free, 8, dt);
  const flight = basis(heading, UP);
  flight.multiply(tmpQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), state.bank));
  flight.multiply(tmpQ.setFromAxisAngle(X_AXIS, pitch));
  bf.group.quaternion.slerpQuaternions(state.rest.quat, flight, air);
  // The abdomen swings against the wings.
  bf.abdomen.rotation.x = deg(-6) + deg(10) * Math.sin(state.phase + 1.2) * state.flap * air;

  if (s >= 1) {
    if (state.mode === 'takeoff') { state.mode = 'away'; state.timer = 1.4; bf.group.visible = false; }
    else { state.mode = 'rest'; bf.abdomen.rotation.x = deg(-6); }
  }
}

function idle(dt) {
  // Mostly basking with the blue open (wild morphos rest closed more often, but the blue is the
  // point of the piece), closing now and then to show the brown underside.
  state.restSwitch -= dt;
  if (state.restSwitch <= 0) {
    const open = state.restTarget > deg(45);
    state.restTarget = open ? deg(rand(4, 25)) : CLOSED;
    state.restSwitch = open ? rand(5, 10) : rand(1, 2.5);
    // Basking wings are never quite symmetric, and a few degrees of tilt swings the structural
    // blue's brightness a lot (reflection moves by twice the tilt): est., from photos where the
    // two sides differ clearly.
    if (!open) state.leanTarget = deg(rand(-6, 6));
  }
  // ?pose=open or ?pose=closed holds the wings still, for comparing against reference photos.
  if (pose) [state.restTarget, state.leanTarget] = pose === "open" ? [deg(4), deg(5)] : [CLOSED, 0];
  state.restAngle = THREE.MathUtils.damp(state.restAngle, state.restTarget, 5, dt);
  state.lean = THREE.MathUtils.damp(state.lean, state.leanTarget, 3, dt);
  bf.setWings(state.restAngle, state.restAngle, 0, state.lean);
}

// ---------- input ----------

const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function hitsButterfly(e) {
  ndc.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = onWall();
  return hit && hit.distanceTo(state.rest.pos) < 0.035;
}
// Drag orbits the camera, Shift+drag moves the sun, and a tap (no drag) touches the butterfly.
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.005, 0);
controls.enableDamping = true;
controls.enablePan = false;
// Stay in front of the wall.
Object.assign(controls, { minDistance: 0.05, maxDistance: 1.2, minAzimuthAngle: deg(-80), maxAzimuthAngle: deg(80), minPolarAngle: deg(10), maxPolarAngle: deg(170) });
controls.update();

const sunAngles = { az: Math.atan2(sunDir.x, sunDir.z), el: Math.asin(sunDir.y) };
function placeSun() {
  const c = Math.cos(sunAngles.el);
  sunDir.set(Math.sin(sunAngles.az) * c, Math.sin(sunAngles.el), Math.cos(sunAngles.az) * c);
}
// ?sun=az,el in degrees (az from the wall normal toward +x), for repeatable comparisons.
const sunParam = params.get('sun');
if (sunParam) {
  [sunAngles.az, sunAngles.el] = sunParam.split(',').map((v) => deg(+v));
  placeSun();
}
let down = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY, sun: e.shiftKey };
  controls.enabled = !e.shiftKey;
});
addEventListener('pointerup', (e) => {
  if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5 && state.mode === 'rest' && hitsButterfly(e)) takeOff();
  down = null;
  controls.enabled = true;
});
addEventListener('pointermove', (e) => {
  if (!down?.sun) return;
  // Front hemisphere only: from grazing along one side of the wall to the other.
  sunAngles.az = THREE.MathUtils.clamp(sunAngles.az + e.movementX * 0.01, deg(-85), deg(85));
  sunAngles.el = THREE.MathUtils.clamp(sunAngles.el - e.movementY * 0.01, deg(-85), deg(85));
  placeSun();
});
renderer.domElement.addEventListener('pointermove', (e) => {
  renderer.domElement.style.cursor = state.mode === 'rest' && hitsButterfly(e) ? 'pointer' : '';
});
hud.textContent = '蝶に触れてみてください ・ ドラッグで視点 ・ Shift+ドラッグで太陽';

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- loop ----------

const clock = new THREE.Clock();
// Hand-held: the view sways by ~0.05° in slow, uneven drifts. Only the rotation is touched, after the
// orbit controls have set the camera, so the controls never see it.
const HANDHELD = deg(0.05);
function handheld(t) {
  const sway = (a, b, c) => (Math.sin(t * a) * 0.5 + Math.sin(t * b + 1.7) * 0.3 + Math.sin(t * c + 4.1) * 0.2) * HANDHELD;
  camera.rotateX(sway(0.9, 2.3, 5.1));
  camera.rotateY(sway(0.7, 1.9, 4.3));
  camera.rotateZ(sway(0.5, 1.3, 3.7) * 0.5);
}
// ?slow=0.1 plays time slower, for watching the wingbeats.
const timeScale = +(params.get('slow') ?? 1);
let realRadius = 0;
const envAt = { sun: new THREE.Vector3(), pos: new THREE.Vector3(0, 0, -1), radius: 0 };
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 1 / 30) * timeScale;
  if (state.mode === 'rest') idle(dt);
  else if (state.mode === 'away') {
    state.timer -= dt;
    if (state.timer <= 0) { bf.group.visible = true; comeBack(); }
  } else fly(dt);

  // Keep the butterfly in focus wherever it is.
  sun.target.position.copy(bf.group.position);
  sun.position.copy(bf.group.position).addScaledVector(sunDir, 0.7);
  // The wall follows the butterfly: whole around it when it rests, shrinking as it flies out, gone
  // while it's away (and built back up when it returns).
  const z = Math.abs(bf.group.position.z);
  const realTarget = bf.group.visible ? 0.12 * (1 - THREE.MathUtils.smoothstep(z, 0.03, 0.35)) : 0;
  realRadius = THREE.MathUtils.damp(realRadius, realTarget, 2, dt);
  rift.update(dt, bf.group.position.x, bf.group.position.y, realRadius);
  // Re-capture the environment when the sun turns, the wall has grown or shrunk, or the butterfly has
  // moved: 1 cm near the wall, more further out, where the wall's share of the view changes slowly.
  if (!sunDir.equals(envAt.sun) || Math.abs(realRadius - envAt.radius) > 0.01 ||
      bf.group.position.distanceTo(envAt.pos) > 0.01 + 0.25 * z) {
    envAt.sun.copy(sunDir);
    envAt.radius = realRadius;
    envAt.pos.copy(bf.group.position);
    captureEnvironment(envAt.pos.clone().setZ(Math.max(envAt.pos.z, 0.003)));
  }
  controls.target.lerp(state.rest.pos, 1 - Math.exp(-2 * dt));
  controls.update();
  handheld(clock.elapsedTime);
  focus.value = THREE.MathUtils.damp(focus.value, camera.position.distanceTo(bf.group.position), 6, dt);
  pipeline.render();
});
