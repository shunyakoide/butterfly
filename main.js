import * as THREE from 'three/webgpu';
import { pass, uniform, vec2, vec4, float, smoothstep, screenUV, mix, mrt, output } from 'three/tsl';
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { chromaticAberration } from 'three/addons/tsl/display/ChromaticAberrationNode.js';
import { film } from 'three/addons/tsl/display/FilmNode.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { Butterfly } from './butterfly.js';
import { morphoPattern } from './pattern.js';
import { buildRift, buildSpace, VOID, PLATFORM } from './rift.js';
import { buildCircuit } from './circuit.js';
import { buildGlass } from './glass.js';
import { buildOverlay } from './fx.js';
import { buildDigital, STYLES } from './digital.js';
import { buildMotion } from './motion.js';
import { buildFlight } from './flight.js';

// Units are meters. The wall is the z = 0 plane, facing +z.
const HDRI = 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/garden_nook_2k.hdr';
const deg = THREE.MathUtils.degToRad;
const hud = document.getElementById('hud');
// A failed start leaves a message instead of a dark page, then stops the module.
function fail(message, error) {
  hud.textContent = message;
  throw error;
}
const params = new URLSearchParams(location.search);

// ?perf shows the frame rate and the GPU time per frame (timestamp queries), for tuning.
const perf = params.has('perf');
const perfAt = { frames: 0, captures: 0, since: performance.now() };
const renderer = new THREE.WebGPURenderer({ antialias: true, trackTimestamp: perf });
// 1.75, not the screen's 2: side by side in close, wide and backlit views it looked the same (only
// hair tips soften, and only when zoomed to the pixel), and it renders at 45-48 fps instead of 38-39.
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 0.75;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // WebGPU has no PCFSoft; shadow.radius softens
document.body.appendChild(renderer.domElement);
await renderer.init().catch((e) => fail('このブラウザでは 3D を描けません(WebGPU / WebGL2 が必要です)', e));

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.01, 60); // far: the space behind the wall
camera.position.set(0.1, -0.12, 0.25);
camera.lookAt(0, 0.005, 0);
const cameraRest = camera.quaternion.clone(); // the view is fixed; only the hand-held sway turns it

// ---------- walls (rift/circuit/glass.js), and the space behind them (rift.js) ----------

// Three walls to choose from: the columns, circuitry or a crystal block (?wall=circuit|glass, or W to
// cycle). The shadow and the space behind are shared; the specks take each wall's colour. All of them
// answer where the feet are, through one pair of uniforms set in the loop.
const feet = { centre: uniform(new THREE.Vector2()), radius: uniform(0) };
const walls = { columns: buildRift(camera, feet), circuit: buildCircuit(camera, feet), glass: buildGlass(camera, feet) };
const space = buildSpace(feet);
scene.add(space.group, ...Object.values(walls).map((w) => w.wall));
const WALLS = Object.keys(walls);
const SPECKS = { columns: 0xffffff, circuit: 0xffb070, glass: 0xd8e4ee };
let wallKind = WALLS.includes(params.get('wall')) ? params.get('wall') : 'columns';
function showWall() {
  for (const [kind, w] of Object.entries(walls)) w.wall.visible = w.envWall.visible = kind === wallKind;
  space.specks.material.color.set(SPECKS[wallKind]);
}
showWall();

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
const sunAngles = { az: Math.atan2(sunDir.x, sunDir.z), el: Math.asin(sunDir.y) };
function placeSun() {
  const c = Math.cos(sunAngles.el);
  sunDir.set(Math.sin(sunAngles.az) * c, Math.sin(sunAngles.el), Math.cos(sunAngles.az) * c);
}
// ?sun=az,el in degrees (az from the wall normal toward +x), for repeatable comparisons; held to the
// front hemisphere like the drag, and ignored unless both numbers are given.
const sunParam = (params.get('sun') ?? '').split(',').map(Number);
if (sunParam.length === 2 && sunParam.every(Number.isFinite)) {
  [sunAngles.az, sunAngles.el] = sunParam.map((v) => THREE.MathUtils.clamp(deg(v), deg(-85), deg(85)));
  placeSun();
}

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
const hdr = await new HDRLoader().loadAsync(HDRI).catch((e) => fail('空の光の画像を読み込めませんでした。通信を確かめて、もう一度開いてください', e));
hdr.mapping = THREE.EquirectangularReflectionMapping;
const hdrSunAz = removeSun(hdr);
const ENV = 0.45;
// Everything the camera sees past the wall is the space behind it (see rift.js).
scene.background = new THREE.Color(VOID);
scene.environmentIntensity = ENV;

// The butterfly sits a few mm from the wall: the sky is only in front, behind is dark but for the
// glowing walls. So its environment is captured from where it is, in a scene with just the sky and
// the walls.
const pmrem = new THREE.PMREMGenerator(renderer);
const envScene = new THREE.Scene();
envScene.background = hdr;
envScene.add(space.envBehind, ...Object.values(walls).map((w) => w.envWall));
let envTarget = null;
// What the last capture was taken for; radius -1 forces a new one.
const envAt = { sun: new THREE.Vector3(), pos: new THREE.Vector3(0, 0, -1), radius: 0 };
function captureEnvironment(pos) {
  perfAt.captures++;
  const rot = sunAngles.az - hdrSunAz;
  envScene.backgroundRotation.y = rot;
  envTarget = pmrem.fromScene(envScene, 0, 0.001, 40, { size: 128, position: pos, renderTarget: envTarget });
  scene.environment = envTarget.texture;
}

// ---------- post: shallow macro depth of field, and the lens ----------

const pipeline = new THREE.RenderPipeline(renderer);
const scenePass = pass(scene, camera, { samples: 4 });
const focus = uniform(camera.position.length());
// Depth of field, made cheap: the same circle of confusion as three's DOF (fully out of focus 3 cm
// from the focal plane), but instead of its 64-tap bokeh, two blurred copies at half resolution
// (light and stronger) mixed by it. The camera never moves and the focus stays on the
// butterfly, so this is all the macro look needs, at a fraction of the cost (DOF was most of the GPU
// time).
const colour = scenePass.getTextureNode();
const coc = smoothstep(0, 0.03, scenePass.getViewZNode().negate().sub(focus).abs());
// Sized to match the old bokeh: a disc of ~8 px at bokeh 4, roughly a gaussian of 2 half-res texels.
const soft = gaussianBlur(colour, null, 1, { resolutionScale: 0.5 });
const blurred = gaussianBlur(colour, null, 2, { resolutionScale: 0.5 });
const sharp = mix(colour, mix(soft, blurred, smoothstep(0.35, 1, coc)), smoothstep(0, 0.35, coc));
// What a real lens and sensor add, so the frame reads as photographed: glow around the bright lines
// and highlights, a little colour fringing toward the corners, darker corners, and fine grain.
const lens = (image) => {
  const glowing = image.add(bloom(image, 0.2, 0.3, 1.1)); // threshold above the lit wings, so only highlights and lines glow
  return chromaticAberration(glowing, 0.2, vec2(0.5, 0.5), 1.0);
};
const vignette = smoothstep(0.35, 0.95, screenUV.sub(0.5).length().mul(1.4)).mul(0.45).oneMinus();
// (outputNode is set below, once the butterfly exists for the overlay.)

// ---------- butterfly ----------

// ?wear=0..1 overrides the random wear, for checking old, worn individuals.
const wearParam = params.get('wear'), wear = Number.isFinite(+wearParam) ? THREE.MathUtils.clamp(+wearParam, 0, 1) : null;
// ?species=peleides|menelaus|achilles|helenor|rhetenor|cypris|sulkowskyi picks one; otherwise each load draws one at random.
const bf = new Butterfly({ ...morphoPattern(undefined, params.get('species')), ...(wearParam && wear !== null && { wear }) });
scene.add(bf.group);

// The analysis overlay (fx.js): E to toggle, ?fx=on to start with it. Its insets go in before the
// vignette and grain, so they read as part of the same photographed frame.
const overlay = buildOverlay({ camera, bf, frame: scenePass.getTextureNode() });
overlay.toggle(params.get('fx') === 'on');

// The butterfly as a screen print (digital.js): D steps through the styles and off, ?print=dots|
// halftone|pixels|chrome|holo|topo|thermal to start with one. The butterfly's materials always write a mask beside the colour
// (switching the scene pass's outputs at run time breaks the pipelines already built for the rest).
scenePass.setMRT(mrt({ output, mask: float(0) }));
scenePass.getTexture('mask').type = THREE.UnsignedByteType;
const bfMask = mrt({ mask: float(1) });
bf.group.traverse((o) => { if (o.isMesh) o.material.mrtNode = bfMask; });
const digital = buildDigital({ pixelRatio: () => renderer.getPixelRatio(), colour, smooth: blurred.getTextureNode(), mask: scenePass.getTextureNode('mask') });
// Glowing scales shed from the wings (motion.js), always on.
const motion = buildMotion({ scene, camera, bf });
const chains = {};
let printStyle = STYLES.includes(params.get('print')) ? params.get('print') : null;
function setOutput() {
  // Each chain is built once (its bloom holds render targets).
  pipeline.outputNode = chains[printStyle] ??= film(vec4(overlay.apply(lens(digital.apply(sharp, printStyle)).rgb).mul(vignette), 1), float(0.12));
  pipeline.needsUpdate = true;
}
setOutput();

// Where it rests and how it flies (flight.js); ?pose=open|closed holds the wings still.
const flight = buildFlight({ bf, camera, pose: params.get('pose'), sun: sunDir });
const { state } = flight;

// ---------- input ----------

const ndc = new THREE.Vector2();
const overButterfly = (e) => flight.touches(ndc.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1));
// Drag moves the sun, and a tap (no drag) touches the butterfly. The view is fixed.
// Moves are measured from the last position, not movementX, which touch pointers may leave at 0.
let down = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY };
});
addEventListener('pointerup', (e) => {
  if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5 && overButterfly(e)) flight.takeOff();
  down = null;
});
addEventListener('pointercancel', () => (down = null));
addEventListener('pointermove', (e) => {
  if (!down) return;
  // Front hemisphere only: from grazing along one side of the wall to the other.
  sunAngles.az = THREE.MathUtils.clamp(sunAngles.az + (e.clientX - down.lastX) * 0.01, deg(-85), deg(85));
  sunAngles.el = THREE.MathUtils.clamp(sunAngles.el - (e.clientY - down.lastY) * 0.01, deg(-85), deg(85));
  [down.lastX, down.lastY] = [e.clientX, e.clientY];
  placeSun();
});
renderer.domElement.addEventListener('pointermove', (e) => {
  renderer.domElement.style.cursor = overButterfly(e) ? 'pointer' : '';
});
// Phones have no keys, so they get only the touch hints.
hud.textContent = [`Morpho ${bf.species}`, '蝶に触れてみてください', 'ドラッグで太陽',
  ...(matchMedia('(pointer: coarse)').matches ? [] : ['W で壁を切り替え', 'E で分析表示', 'D で描き方を切り替え'])].join(' ・ ');
addEventListener('keydown', (e) => {
  if (e.key === 'e' || e.key === 'E') overlay.toggle();
  if (e.key === 'd' || e.key === 'D') { printStyle = [...STYLES, null][(STYLES.indexOf(printStyle) + 1) % (STYLES.length + 1)]; setOutput(); }
  if (e.key !== 'w' && e.key !== 'W') return;
  wallKind = WALLS[(WALLS.indexOf(wallKind) + 1) % WALLS.length];
  showWall();
  envAt.radius = -1; // re-capture the environment: the light from the wall has changed
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  for (const w of Object.values(walls)) w.fit();
});

// ---------- loop ----------

const clock = new THREE.Clock();
// Hand-held: the view sways by ~0.05° in slow, uneven drifts about its fixed direction.
const HANDHELD = deg(0.05);
function handheld(t) {
  const sway = (a, b, c) => (Math.sin(t * a) * 0.5 + Math.sin(t * b + 1.7) * 0.3 + Math.sin(t * c + 4.1) * 0.2) * HANDHELD;
  camera.quaternion.copy(cameraRest);
  camera.rotateX(sway(0.9, 2.3, 5.1));
  camera.rotateY(sway(0.7, 1.9, 4.3));
  camera.rotateZ(sway(0.5, 1.3, 3.7) * 0.5);
}
// ?slow=0.1 plays time slower, for watching the wingbeats (0 < slow <= 1; anything else plays at 1).
const slow = +params.get('slow'), timeScale = slow > 0 && slow <= 1 ? slow : 1;
let realRadius = 0;
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 1 / 30) * timeScale;
  flight.update(dt);

  // The sun, and its shadow camera, follow the butterfly.
  sun.target.position.copy(bf.group.position);
  sun.position.copy(bf.group.position).addScaledVector(sunDir, 0.7);
  // The wall answers only where the feet are: it builds up after touchdown, around the resting spot,
  // and dies away at take-off; nothing follows the butterfly in flight.
  realRadius = THREE.MathUtils.damp(realRadius, state.mode === 'rest' ? PLATFORM : 0, state.mode === 'rest' ? 2 : 5, dt);
  feet.centre.value.set(state.rest.pos.x, state.rest.pos.y);
  feet.radius.value = realRadius;
  space.update(dt);
  // Re-capture the environment (six renders of the surroundings and a blur, ~50-150 ms) only while the
  // butterfly rests (not walking, the sun not being dragged), when the sun turns, it has landed or walked somewhere new or the wall around it has grown
  // by a third; in flight it is small and quick, and the hitches showed while the lighting did not.
  if (state.mode === 'rest' && !state.walk && !down && (!sunDir.equals(envAt.sun) || Math.abs(realRadius - envAt.radius) > 0.04 ||
      bf.group.position.distanceTo(envAt.pos) > 0.01)) {
    envAt.sun.copy(sunDir);
    envAt.radius = realRadius;
    envAt.pos.copy(bf.group.position);
    captureEnvironment(envAt.pos.clone().setZ(Math.max(envAt.pos.z, 0.003)));
  }
  handheld(clock.elapsedTime);
  // Keep the butterfly in focus wherever it is.
  focus.value = THREE.MathUtils.damp(focus.value, camera.position.distanceTo(bf.group.position), 6, dt);
  pipeline.render();
  overlay.update(clock.elapsedTime);
  digital.update(dt, state.mode);
  motion.update(dt, state.mode);
  if (perf) showPerf();
});

// Every half second the GPU time of all the frames since (the timestamp queries pile up until
// resolved) is shown per frame, with the frame rate. window.app lets the console switch parts off to
// see what they cost.
if (perf) window.app = { renderer, pipeline, scene, camera, scenePass, walls, space, overlay, bf, outputs: { sharp }, digital, flight };
function showPerf() {
  perfAt.frames++;
  const now = performance.now();
  if (now - perfAt.since < 500) return;
  const frames = perfAt.frames, fps = frames * 1000 / (now - perfAt.since), captures = perfAt.captures;
  renderer.resolveTimestampsAsync('render').then((ms) => {
    window.perfStats = { fps, gpu: (ms ?? 0) / frames, captures };
    hud.textContent = `${fps.toFixed(0)} fps · GPU ${window.perfStats.gpu.toFixed(2)} ms/frame`;
  });
  Object.assign(perfAt, { frames: 0, captures: 0, since: now });
}
