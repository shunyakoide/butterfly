import * as THREE from 'three/webgpu';
import { REST_HEIGHT } from './butterfly.js';

// The butterfly's behaviour: where it rests, how it flies off and comes back, and how its wings move.
// main.js calls update(dt) every frame and reads state.mode and state.rest.pos.
const deg = THREE.MathUtils.degToRad;
const WALL_N = new THREE.Vector3(0, 0, 1);
const UP = new THREE.Vector3(0, 1, 0);
const rand = THREE.MathUtils.randFloat;
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
    heading,
    quat: basis(new THREE.Vector3(Math.cos(heading), Math.sin(heading), 0), WALL_N),
  };
}
// Where the wall was: a 0.8 m square, for picking points on it (most of it is no longer drawn).
const wallPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const ray = new THREE.Raycaster();
function onWall() {
  const p = ray.ray.intersectPlane(wallPlane, new THREE.Vector3());
  return p && Math.abs(p.x) < 0.4 && Math.abs(p.y) < 0.4 ? p : null;
}

// Flight kinematics of M. helenor (which includes peleides), from Le Roy et al. 2019
// (doi:10.1242/jeb.204057), 2022 (doi:10.1242/jeb.243867) and the 2021 gliding preprint
// (doi:10.1101/2021.03.22.436469). Values marked "est." were not found and are set by eye.
const BEAT_HZ = 5.9;                 // free flight, ±1.7
const STROKE_TOP = deg(88);          // wings (nearly) clap above the back
const STROKE_AMP = deg(128);         // forewing amplitude, understory species
// Fore and hind wings stroke in phase (they overlap), but the hindwing's pitch swings more and a
// quarter-beat later (monarch: Lou et al. 2024).
const HIND_TWIST = 1.3;
const TWIST = deg(35);               // pronation on the downstroke, supination on the upstroke (painted lady, up to ~40°: Zheng et al. 2013)
const SPEED = 1.3;                   // m/s, climbing escape flight
const CLIMB = Math.tan(deg(13));     // path slope while flapping
const SINK = Math.tan(deg(11));      // glide slope
const GLIDE_WINGS = deg(12);         // est.: slight dihedral while gliding
const PITCH = deg(44);               // body pitch, climbing flight
const BOB = 0.012;                   // est.: body heave per wingbeat (m); Morpho moves 0.3–0.4 m per beat
const START_SPEED = 0.2;             // est.: speed off the leg push, and at touchdown
// Path irregularity: no turning rates or sinuosity values were found for Morpho. Understory species
// fly fairly straight and fast (Le Roy 2021), so the meander is kept moderate (sinuosity ~1.15).
const WANDER = 0.025;                // est.: meander off the planned path (m), sideways and up/down
const KICK = 0.02;                   // est.: sideways jink at the start of each flapping bout (m)
const MAX_BANK = deg(40);            // est.: roll limit in turns
// What it does between leaving the wall and settling again, so that not every flight is the same
// out-and-back. Males of understory Morpho patrol back and forth along streams and trails (Le Roy
// 2021 filmed them patrolling; the back-and-forth is from field guides, a secondary source), so it
// sometimes crosses the view and leaves again before it comes in. Butterflies also often settle a
// short hop away rather than leave, and veer off from a first approach before landing on a second;
// no rates were found for any of these (est.).
const HOP = 0.35;                    // est.: chance a flight it starts on its own is a short hop within view
const PASS = 0.3;                    // est.: chance, each time it comes back, that it only crosses the view
const ABORT = 0.3;                   // est.: chance a landing first veers off a few cm from the wall

// Walking on the wall. Basking butterflies with open wings most often settle with their back to the
// sun (Clench 1966, via Arctic 23:268), and some turn on the spot after landing until they find it
// (a lycaenid observation, secondary source): so after landing, and whenever the sun moves, it turns
// to put its back to the sun, and now and then takes a few steps along that way. Nymphalids walk on
// the mid and hind legs (Wolfe et al. 2011). Slow insects swing one leg at a time, each swing passing
// from back to front (Ambe et al. 2018), and stick insects' mid and hind legs keep to a quadruped's
// walk (Grabowska et al. 2012): left hind, left mid, right hind, right mid. Speeds and timings were
// not found for butterflies (est.); like flies, it walks faster by stepping more often, not by
// swinging slower (Drosophila: swing time ~constant).
const WALK_SPEED = 0.012;            // m/s (est.)
const TURN_RATE = deg(50);           // per second (est.)
const BASK_TOLERANCE = deg(25);      // est.: how far off its back-to-the-sun heading it puts up with
// How it rests, chosen at each landing. Morphos mostly rest with the wings closed, showing the brown
// underside, and open them now and then to warm up (Britannica; field guides). Butterflies warming
// with the wings open turn their back to the sun (dorsal basking), those warming with them closed
// turn their side to it (lateral basking: Clench 1966, via Arctic 23:268 and Rawlins 1978), and in
// the shade of the understory they need not turn at all. The shares and times are est.
// A cursor resting over it bothers it, and it opens its wings, holding them open while the cursor
// stays and a little after. Morphos open them when disturbed (M. rhetenor flicks them open and shut
// at ants and wasps: field guides); held open here so that the blue can be looked at.
const DISTURBED_HOLD = [2, 4];       // s the wings stay open after the cursor leaves (est.)
const BASKING = [
  { p: 0.3, face: 'back', open: [5, 10], closed: [1, 2.5] },  // basking open, closing now and then
  { p: 0.35, face: 'side', open: [1, 3], closed: [6, 14] },   // basking closed, opening briefly
  { p: 0.35, face: null, open: [1, 3], closed: [6, 14] },     // resting in the shade
];
const STEP_TIME = 0.12;              // s, one swing (est.)
const STEP_LIFT = 0.0012;            // m, foot raised off the wall mid-swing (est.)
const SETTLE_AT = 0.0006;            // m, how far a foot may trail its rest spot before it steps
const ORDER = [1, 0, 3, 2];          // bf.legs: [left mid, left hind, right mid, right hind]; stepped hind, mid, hind, mid
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// Legs in the air. At take-off the mid and hind legs push off, their feet held on the wall as the
// body rises and the knees open (Pieris rapae: by 0.4-1.1 rad within 18 ms, starting just before the
// body moves; the forelegs stay folded: Bimbard et al. 2013, JEB 216:3551). Then they fold in under
// the body for the flight (est.: drawn in against drag; no measurements found), and before
// touchdown they reach out toward the wall (flies extend theirs on coming within a set distance of the
// surface: van Breugel & Dickinson 2012; the distances here are est.).
const PUSH = 0.004;                  // m the body rises before the feet let go: ~20 ms at START_SPEED
const FOLD = 0.05;                   // m of flight over which the legs fold in after letting go (est.)
const REACH = [0.06, 0.02];          // m before touchdown: from folded to reaching out (est.)
const SETTLE = 0.004;                // m before touchdown: from reaching out to standing (est.)
const BODY_UP = new THREE.Vector3(0, 0, 1);

const tmpQ = new THREE.Quaternion();
const X_AXIS = new THREE.Vector3(1, 0, 0);

// pose: ?pose=open|closed (see idle). sun: the direction toward the sun, kept up to date by main.js.
export function buildFlight({ bf, camera, pose, sun }) {
  // Points chosen through the current view, so the flight crosses the frame wherever the camera is.
  function throughView(x, y, off) {
    ray.setFromCamera(new THREE.Vector2(x, y), camera);
    const hit = onWall();
    return hit ? hit.addScaledVector(WALL_N, off) : ray.ray.at(0.4, new THREE.Vector3());
  }
  // Just outside the frame: left, right or top (0, 1, 2), any of them if not given.
  function offscreenPoint(which = Math.floor(Math.random() * 3)) {
    const side = [[-1.6, rand(-0.5, 0.8)], [1.6, rand(-0.5, 0.8)], [rand(-0.8, 0.8), 1.6]][which];
    return throughView(side[0], side[1], rand(0.06, 0.15));
  }
  // A few cm off the wall, inside the frame.
  function wanderPoint() {
    return throughView(rand(-0.6, 0.6), rand(-0.4, 0.6), rand(0.03, 0.08));
  }

  const state = {
    mode: 'rest',
    rest: restPose(0, 0, deg(80)),
    curve: null, dist: 0, length: 1, speed: 1,
    phase: 0, timer: 0, flapping: 1, flap: 1, bout: 3, glide: 0, alt: 0,
    restAngle: deg(10), restTarget: deg(10), restSwitch: rand(5, 10), lean: 0, leanTarget: deg(rand(-6, 6)),
    idleT: 0, aim: [[0, 0, 0, 0], [0, 0, 0, 0]],
    walk: null, walkWait: 0, walkT: 0, gait: 0, feet: null,
  };
  bf.group.position.copy(state.rest.pos);
  bf.group.quaternion.copy(state.rest.quat);
  plant();

  // Where foot i stands at rest under the body as it is now, in the world.
  function restFoot(i) {
    const f = bf.legs.rest[i];
    return { ankle: bf.group.localToWorld(f.ankle.clone()), tip: bf.group.localToWorld(f.tip.clone()) };
  }
  // The feet hold on to the wall where they are: from now on they move only by stepping.
  function plant() {
    bf.group.updateMatrixWorld();
    state.feet = bf.legs.rest.map((_, i) => ({ ...restFoot(i), s: 1 }));
    state.walkWait = rand(1, 2.5); // settles its feet, then looks for the sun
    let pick = Math.random();
    state.basking = BASKING.find((b) => (pick -= b.p) < 0) ?? BASKING[0];
    // Unless tapped, it stays a while and then flies off on its own (est.: no resting times found).
    state.stay = rand(30, 90);
  }

  // Where it will land: somewhere inside the middle of the current view, whatever the aspect ratio.
  function landingSpot() {
    ray.setFromCamera(new THREE.Vector2(rand(-0.5, 0.5), rand(-0.45, 0.45)), camera);
    // Off the wall's edge (onWall gives null), land in the middle instead: comeBack runs every frame
    // until it succeeds, so a throw here froze the butterfly.
    return onWall() ?? new THREE.Vector3();
  }
  // It touches down facing the way it came in along the wall (from the last point before the final
  // approach), give or take (est.). A fixed range of headings, with the sun fixed, made the turn to
  // bask after landing go the same way every time.
  function settleOn(spot, from) {
    state.rest = restPose(spot.x, spot.y, Math.atan2(spot.y - from.y, spot.x - from.x) + deg(rand(-25, 25)));
  }
  // The last two points of every landing: in front of the spot and a little above it, then the spot.
  const approach = (p) => [p.clone().addScaledVector(WALL_N, 0.045).add(new THREE.Vector3(rand(-0.02, 0.02), 0.015, 0)), p.clone()];

  // mode: 'takeoff' leaves the wall, 'landing' ends on it, 'flying' does neither; a hop does both
  // (mode 'takeoff', ends: [true, true]).
  function startJourney(mode, points, speed, ends = [mode === 'takeoff', mode === 'landing']) {
    state.mode = mode;
    state.ends = ends;
    state.curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
    state.length = state.curve.getLength();
    state.speed = speed;
    state.dist = 0;
    Object.assign(state, { t: 0, kick: 0, kickNow: 0, bank: 0, lastPos: null, vel: null, prevVel: null,
      wobble: [0, 1, 2, 3].map(() => Math.random() * Math.PI * 2) });
  }

  // The feet stay on the wall for the push (airLegs). Tapped, it always escapes out of view; leaving
  // on its own, it may only hop to another spot in view.
  function takeOff(escape = true) {
    state.walk = null;
    const p = state.rest.pos;
    // The legs push off first, so the body leaves the wall before the wings give much lift.
    const push = p.clone().addScaledVector(WALL_N, 0.03).add(new THREE.Vector3(0, 0.012, 0));
    if (!escape && Math.random() < HOP) {
      const spot = landingSpot();
      // A hop of a few cm is no flight at all: then it goes up and around first.
      const via = [wanderPoint(), ...(spot.distanceTo(p) < 0.1 ? [wanderPoint()] : [])];
      settleOn(spot, via.at(-1));
      startJourney('takeoff', [p.clone(), push, ...via, ...approach(state.rest.pos)], SPEED * 0.8, [true, true]);
    } else startJourney('takeoff', [p.clone(), push, wanderPoint(), offscreenPoint()], SPEED);
    // The first downstroke starts with the wings at the top (from closed, a fling).
    Object.assign(state, { phase: 0, flapping: 1, bout: 3, alt: 0 });
  }

  function comeBack() {
    if (Math.random() < PASS) {
      // Across the view and out the other side: a patrol pass. It comes back once more after.
      const from = Math.random() < 0.5 ? 0 : 1;
      startJourney('flying', [offscreenPoint(from), wanderPoint(), wanderPoint(), offscreenPoint(1 - from)], SPEED);
      Object.assign(state, { flapping: 1, bout: 3, alt: 0 });
      return;
    }
    const spot = landingSpot(), p = spot.clone().setZ(REST_HEIGHT);
    // A first approach that veers off 1.5-3 cm short of the wall and swings back out, then a second
    // that lands.
    const abort = Math.random() < ABORT ? [
      p.clone().addScaledVector(WALL_N, rand(0.015, 0.03)).add(new THREE.Vector3(rand(-0.04, 0.04), rand(-0.02, 0.03), 0)),
      throughView(rand(-0.6, 0.6), rand(-0.4, 0.6), rand(0.06, 0.12)),
    ] : [];
    const via = [wanderPoint(), ...abort];
    settleOn(spot, via.at(-1));
    startJourney('landing', [offscreenPoint(), ...via, ...approach(state.rest.pos)], SPEED * 0.8);
    // After touchdown the wings fold up closed.
    Object.assign(state, { flapping: 1, bout: 4, alt: 0, restAngle: CLOSED, restTarget: CLOSED, restSwitch: rand(0.8, 1.5) });
  }

  function fly(dt) {
    // Slow near the wall, full speed in the open: speeding up over the first ~12 cm after the leg
    // push, slowing over the last ~12 cm before touchdown. (At this macro framing, 1.3 m/s crosses
    // the frame in a tenth of a second.)
    const [start, end] = state.ends;
    const fromWall = Math.min(start ? state.dist : Infinity, end ? state.length - state.dist : Infinity);
    const v = THREE.MathUtils.lerp(START_SPEED, state.speed, THREE.MathUtils.smoothstep(fromWall, 0, 0.12));
    state.dist = Math.min(state.length, state.dist + v * dt);
    const s = state.dist / state.length;
    const pos = state.curve.getPointAt(s);
    const tangent = state.curve.getTangentAt(Math.min(s, 0.999));

    // How "airborne" we are: 0 standing on the wall, 1 in free flight.
    const smooth = THREE.MathUtils.smoothstep;
    // A hop folds its wings closed on touchdown like any landing: set once it is well airborne, where
    // the rest angle no longer shows (at take-off the wings start from the angle they rested at).
    if (start && end && s > 0.5) Object.assign(state, { restAngle: CLOSED, restTarget: CLOSED, restSwitch: rand(0.8, 1.5) });
    const air = (start ? smooth(s, 0, 0.06) : 1) * (end ? 1 - smooth(s, 0.85, 1) : 1);
    // Gliding only in free flight, away from the wall.
    const free = (start ? smooth(s, 0.2, 0.35) : 1) * (end ? 1 - smooth(s, 0.6, 0.75) : 1);

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
    state.flap = THREE.MathUtils.damp(state.flap, state.flapping, 12, dt);

    const stroke = (ph) => STROKE_TOP - STROKE_AMP * (0.5 - 0.5 * Math.cos(ph));
    const fore = THREE.MathUtils.lerp(GLIDE_WINGS, stroke(state.phase), state.flap);
    const wings = THREE.MathUtils.lerp(state.restAngle, fore, air);
    const twist = -TWIST * Math.sin(state.phase) * state.flap * air;
    const hindTwist = -TWIST * HIND_TWIST * Math.sin(state.phase - Math.PI / 2) * state.flap * air;
    bf.setWings(wings, wings, twist, state.lean * (1 - air), hindTwist);

    // Climb while flapping, sink while gliding; the offset returns to the path near the wall.
    state.alt += (state.flapping > 0.5 ? CLIMB : -SINK) * SPEED * dt * free;
    state.alt = THREE.MathUtils.clamp(state.alt, -0.03, 0.03) * (0.4 + 0.6 * free);
    // Each downstroke heaves the body: lowest mid-downstroke, when lift peaks (est. amplitude).
    pos.y += (state.alt - BOB * Math.sin(state.phase) * state.flap) * air;
    // Irregular path: slow meander sideways and up/down (sums of incommensurate sines), plus the
    // per-bout jink, away from the wall only.
    state.t += dt;
    state.kickNow = THREE.MathUtils.damp(state.kickNow, state.kick, 4, dt);
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
    const brake = end ? THREE.MathUtils.smoothstep(s, 0.7, 0.95) : 0;
    // Each beat rocks it by ~±25°, a quarter-beat behind the wings: lowest mid-downstroke (Pieris: Suzuki et al. 2022).
    const pitch = THREE.MathUtils.lerp(deg(15), PITCH, state.flap) + deg(20) * brake - deg(25) * Math.sin(state.phase) * state.flap;
    const heading = state.vel.lengthSq() > 0.01 ? state.vel.clone().normalize() : tangent;
    // Bank into turns: roll from the sideways acceleration, as for any flier (a = v·dθ/dt).
    const accel = state.prevVel ? state.vel.clone().sub(state.prevVel).divideScalar(Math.max(dt, 1e-4)) : new THREE.Vector3();
    state.prevVel = state.vel.clone();
    const bankTarget = THREE.MathUtils.clamp(Math.atan2(accel.dot(new THREE.Vector3().crossVectors(heading, UP).normalize()), 9.8), -MAX_BANK, MAX_BANK);
    state.bank = THREE.MathUtils.damp(state.bank, bankTarget * free, 8, dt);
    const flight = basis(heading, UP);
    flight.multiply(tmpQ.setFromAxisAngle(UP, state.bank));
    flight.multiply(tmpQ.setFromAxisAngle(X_AXIS, pitch));
    bf.group.quaternion.slerpQuaternions(state.rest.quat, flight, air);
    // The abdomen swings against the wings: up on the downstroke, down on the upstroke (monarch, Pieris).
    bf.abdomen.rotation.x = deg(-6) - deg(15) * Math.sin(state.phase) * state.flap * air;

    airLegs();

    if (s >= 1) {
      if (!end) { state.mode = 'away'; state.timer = rand(0.8, 2.5); bf.group.visible = false; }
      else { state.mode = 'rest'; bf.abdomen.rotation.x = deg(-6); plant(); }
    }
  }

  function idle(dt) {
    // Open and closed in turn, for as long as this landing's way of resting holds each (BASKING).
    if (state.hovered) {
      if (state.restTarget > deg(45)) state.restTarget = deg(rand(4, 25));
      state.restSwitch = Math.max(state.restSwitch, rand(...DISTURBED_HOLD));
    }
    state.restSwitch -= dt;
    if (state.restSwitch <= 0) {
      const open = state.restTarget > deg(45);
      state.restTarget = open ? deg(rand(4, 25)) : CLOSED;
      state.restSwitch = rand(...(open ? state.basking.open : state.basking.closed));
      // Basking wings are never quite symmetric, and a few degrees of tilt swings the structural
      // blue's brightness a lot (reflection moves by twice the tilt): est., from photos where the
      // two sides differ clearly.
      if (!open) state.leanTarget = deg(rand(-6, 6));
    }
    // ?pose=open or ?pose=closed holds the wings still, for comparing against reference photos.
    if (pose) [state.restTarget, state.leanTarget] = pose === "open" ? [deg(4), deg(5)] : [CLOSED, 0];
    state.restAngle = THREE.MathUtils.damp(state.restAngle, state.restTarget, 5, dt);
    state.lean = THREE.MathUtils.damp(state.lean, state.leanTarget, 3, dt);
    const t = state.idleT += dt;

    // As on a flower, the wings never quite settle: a slow pumping, open from the rest angle (or a
    // little open from closed), every ~2.5 s, by an amount that drifts between 12° and 30° (never so little it looks frozen) (est., from
    // videos of feeding butterflies). Fore and hind wings move together: they overlap, and any lag
    // pushes one through the other.
    const amp = pose ? 0 : deg(12 + 18 * (0.5 + 0.5 * Math.sin(t * 0.21 + 1)));
    const pump = amp * (0.5 - 0.5 * Math.cos(t * 2.5));
    const angle = state.restTarget > deg(45) ? state.restAngle - pump * 0.5 : state.restAngle + pump;
    bf.setWings(angle, angle, 0, state.lean);
    // Breathing comes in bouts: a few small lifts of the abdomen, then a pause (Wasserthal 1980; est. rates).
    bf.abdomen.rotation.x = deg(-6) + deg(1.5) * Math.sin(t * 6) * Math.max(0, Math.sin(t * 0.35)) ** 4;

    // Antennae: mostly held still, each re-aimed by a few degrees every few seconds, now and then a
    // quick twitch that eases back (est.; no measured rates, but continuous swaying looks wrong).
    bf.antennae.forEach((a, i) => {
      const [yaw, pitch, wait] = state.aim[i];
      if (wait <= 0) state.aim[i] = [deg(rand(-6, 6)), deg(rand(-6, 6)), rand(2, 6), Math.random() < 0.25 ? 1 : 0];
      state.aim[i][2] -= dt;
      const twitch = state.aim[i][3];
      if (twitch) state.aim[i][3] = Math.max(0, twitch - dt * 4); // ~0.25 s
      a.rotation.z = THREE.MathUtils.damp(a.rotation.z, yaw + deg(10) * twitch, 6, dt);
      a.rotation.x = THREE.MathUtils.damp(a.rotation.x, pitch - deg(8) * twitch, 6, dt);
    });
  }

  // Turning to put its back or its side to the sun (BASKING), and now and then a few steps that way.
  // It walks the way it faces, so it turns first. Heading out of the middle of the view, it only turns.
  function walk(dt) {
    const r = state.rest;
    // Back to the sun: the head points away from the sun's direction along the wall; side to it: a
    // quarter turn from that, whichever is nearer. With the sun nearly straight in front of the wall,
    // or in the shade, any heading will do.
    const along = Math.hypot(sun.x, sun.y), away = Math.atan2(-sun.y, -sun.x), face = along > 0.15 ? state.basking.face : null;
    const bask = face === 'back' ? away : face === 'side' ? away + Math.sign(wrap(r.heading - away) || 1) * Math.PI / 2 : r.heading;
    const off = wrap(bask - r.heading);
    if (!state.walk && Math.abs(off) > BASK_TOLERANCE * 1.4) state.walkWait = Math.min(state.walkWait, rand(0.5, 1.5));
    if (!state.walk && !pose && (state.walkWait -= dt) <= 0) {
      state.walkWait = rand(6, 14);
      // Never quite exact (est.): within a few degrees either side.
      const heading = r.heading + (Math.abs(off) > BASK_TOLERANCE ? off + deg(rand(-10, 10)) : deg(rand(-10, 10)));
      let dist = Math.random() < 0.5 ? 0 : rand(0.005, 0.02);
      const ahead = (d) => r.pos.clone().add(new THREE.Vector3(Math.cos(heading), Math.sin(heading), 0).multiplyScalar(d));
      const ndc = ahead(dist + 0.02).project(camera);
      if (Math.abs(ndc.x) > 0.6 || Math.abs(ndc.y) > 0.5) dist = 0;
      state.walk = { to: ahead(dist), heading };
    }
    if (state.walk) {
      const w = state.walk, turn = w.heading - r.heading;
      r.heading += THREE.MathUtils.clamp(turn, -TURN_RATE * dt, TURN_RATE * dt);
      // Easing in and out over the first and last few mm, and only once facing the way (no crabbing).
      const off = w.to.clone().sub(r.pos), len = off.length();
      const v = WALK_SPEED * Math.min(1, len / 0.004, 0.2 + state.walkT / 0.5) * Math.max(0, Math.cos(turn)) ** 8;
      if (len > 1e-6) r.pos.addScaledVector(off, Math.min(1, v * dt / len));
      state.walkT += dt;
      if (len < 1e-4 && Math.abs(turn) < 1e-3) state.walk = null;
      r.quat.copy(basis(new THREE.Vector3(Math.cos(r.heading), Math.sin(r.heading), 0), WALL_N));
      bf.group.position.copy(r.pos);
      bf.group.quaternion.copy(r.quat);
    } else state.walkT = 0;

    // Steps, one leg at a time in walking order: the next leg trailing its rest spot under the moved
    // body swings over to it (half as far again while walking, so it lands ahead), the rest hold on.
    // Walking, every leg trails, so the legs step on and on; stopped, the last steps tidy the stance.
    bf.group.updateMatrixWorld();
    const want = state.feet.map((_, i) => restFoot(i));
    if (state.feet.every((f) => f.s >= 1)) {
      for (let k = 0; k < 4; k++) {
        const i = ORDER[state.gait], f = state.feet[i];
        state.gait = (state.gait + 1) % 4;
        if (Math.max(f.ankle.distanceTo(want[i].ankle), f.tip.distanceTo(want[i].tip)) > SETTLE_AT) {
          Object.assign(f, { s: 0, from: { ankle: f.ankle.clone(), tip: f.tip.clone() }, past: state.walk ? 0.5 : 0 });
          break;
        }
      }
    }
    state.feet.forEach((f, i) => {
      if (f.s >= 1) return;
      f.s = Math.min(1, f.s + dt / STEP_TIME);
      const k = 0.5 - 0.5 * Math.cos(Math.PI * f.s);
      for (const key of ['ankle', 'tip']) {
        const to = want[i][key].clone().addScaledVector(want[i][key].clone().sub(f.from[key]), f.past);
        f[key].lerpVectors(f.from[key], to, k).addScaledVector(WALL_N, STEP_LIFT * Math.sin(Math.PI * f.s));
      }
    });
    bf.legs.pose(feetInBody(), WALL_N.clone().applyQuaternion(tmpQ.copy(bf.group.quaternion).invert()));
  }

  // The planted feet in the body's frame.
  function feetInBody() {
    const inv = bf.group.matrixWorld.clone().invert();
    return state.feet.map((f) => ({ ankle: f.ankle.clone().applyMatrix4(inv), tip: f.tip.clone().applyMatrix4(inv) }));
  }

  function airLegs() {
    const L = bf.legs, smooth = THREE.MathUtils.smoothstep;
    const blend = (a, b, k) => a.map((f, i) => ({ ankle: f.ankle.clone().lerp(b[i].ankle, k), tip: f.tip.clone().lerp(b[i].tip, k),
      knee: (f.knee ?? L.rest[i].knee).clone().lerp(b[i].knee, k) }));
    bf.group.updateMatrixWorld();
    const [start, end] = state.ends;
    if (start && state.dist < state.length / 2) {
      if (state.feet && state.dist < PUSH) {
        L.pose(feetInBody(), WALL_N.clone().applyQuaternion(tmpQ.copy(bf.group.quaternion).invert()));
        return;
      }
      if (state.feet) [state.letGo, state.feet] = [feetInBody(), null];
      L.pose(blend(state.letGo, L.tuck, smooth(state.dist, PUSH, PUSH + FOLD)), BODY_UP);
    } else {
      // Never reaching out on a flight that doesn't land (smoothstep of Infinity is 1: legs tucked).
      const left = end ? state.length - state.dist : Infinity;
      const out = blend(L.tuck, L.reach, 1 - smooth(left, REACH[1], REACH[0]));
      L.pose(blend(out, L.rest, 1 - smooth(left, 0, SETTLE)), BODY_UP);
    }
  }

  // Whether a tap at ndc touches the butterfly, which only answers while it rests.
  function touches(ndc) {
    if (state.mode !== 'rest') return false;
    ray.setFromCamera(ndc, camera);
    const hit = onWall();
    return hit && hit.distanceTo(state.rest.pos) < 0.035;
  }

  // pointer: where the cursor is (NDC), or null when it is off the page.
  function update(dt, pointer = null) {
    state.hovered = !!pointer && touches(pointer);
    if (state.mode === 'rest') {
      idle(dt);
      walk(dt);
      if (!pose && (state.stay -= dt) <= 0) takeOff(false);
    }
    else if (state.mode === 'away') {
      state.timer -= dt;
      if (state.timer <= 0) { bf.group.visible = true; comeBack(); }
    } else fly(dt);
  }

  return { state, update, takeOff, touches };
}
