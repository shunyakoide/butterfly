import * as THREE from 'three/webgpu';
import { TEX, FORE, HIND, wingGeometry, reliefNormalMap } from './wing.js';
import { WingMaterial } from './morpho.js';
import { buildBody, LEG_DROP } from './body.js';
import { drawUpper, drawUnder } from './pattern.js';

// A blue morpho. Local frame: +x right, +y forward (head), +z dorsal. Modelled in meters at
// 1/SCALE and scaled up to M. peleides size (forewing ~68 mm, wingspan ~13 cm).
const SCALE = 1.3;

export const REST_HEIGHT = LEG_DROP * SCALE; // body centre above the wall when standing

// ---------- butterfly ----------

function canvasTexture(colorSpace) {
  const c = document.createElement('canvas');
  c.width = c.height = TEX;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = colorSpace;
  t.anisotropy = 8;
  return t;
}

export class Butterfly {
  constructor(pattern) {
    this.group = new THREE.Group();
    this.pattern = pattern;
    // [fore, hind] for each of: upperside colour, upperside roughness, underside colour.
    this.upper = [0, 1].map(() => canvasTexture(THREE.SRGBColorSpace));
    this.rough = [0, 1].map(() => canvasTexture(THREE.NoColorSpace));
    this.under = [0, 1].map(() => canvasTexture(THREE.SRGBColorSpace));
    // [upper, under] relief per wing: veins read faintly through the dorsal scales, more below.
    this.relief = [FORE, HIND].map((w) => [reliefNormalMap(w, 0.35), reliefNormalMap(w, 1)]);

    // Upper side: structural blue lobe (see morpho.js) over a low, white specular. Lit from behind,
    // the thin membrane passes the pigment colours: the underside's browns show through the upper
    // side, but the blue is reflected, not pigment, so the underside glows brown, not blue.
    this.upperMats = [0, 1].map((i) => new WingMaterial({
      structural: true, roughMap: this.rough[i], transMap: this.under[i], shadeMap: this.upper[i], transStrength: 0.3,
      map: this.upper[i], alphaTest: 0.5, alphaToCoverage: true, normalMap: this.relief[i][0], side: THREE.FrontSide,
      roughness: 1, roughnessMap: this.rough[i], specularIntensity: 0.25,
    }));
    this.underMats = [0, 1].map((i) => new WingMaterial({
      transMap: this.under[i], shadeMap: this.upper[i], transStrength: 0.3,
      map: this.under[i], alphaTest: 0.5, alphaToCoverage: true, normalMap: this.relief[i][1], side: THREE.BackSide,
      roughness: 0.7, sheen: 0.6, sheenRoughness: 0.5, sheenColor: 0xc8a878,
    }));
    const body = buildBody();
    this.abdomen = body.userData.abdomen;
    this.antennae = body.userData.antennae;
    this.group.add(body);
    this.group.scale.setScalar(SCALE);

    this.wings = [FORE, HIND];
    // Hinges below: fore at y 1.2 mm, hind at -0.8 mm, so the hindwing's points sit 2 mm further
    // back in the forewing's frame.
    const geos = [wingGeometry(FORE), wingGeometry(HIND, FORE, new THREE.Vector2(0, -0.002))];
    this.pivots = [];
    for (const side of [1, -1]) {
      [[0, [0.0012, 0.0012, 0.0011]], [1, [0.0012, -0.0008, 0.0005]]].forEach(([k, pos]) => {
        const pivot = new THREE.Group();
        pivot.position.set(side * pos[0], pos[1], pos[2]);
        // Two single-sided meshes so the upper and under sides can differ.
        for (const mat of [this.upperMats[k], this.underMats[k]]) {
          const wing = new THREE.Mesh(geos[k], mat);
          wing.scale.x = side;
          pivot.add(wing);
        }
        pivot.userData = { side, hind: k === 1 };
        this.group.add(pivot);
        this.pivots.push(pivot);
      });
    }
    this.group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    this.paint();
  }

  paint() {
    const ctx = (t) => t.image.getContext('2d', { willReadFrequently: true });
    [true, false].forEach((isFore, i) => {
      drawUpper(ctx(this.upper[i]), ctx(this.rough[i]), this.wings[i], this.pattern, isFore);
      drawUnder(ctx(this.under[i]), this.wings[i], this.pattern, isFore);
    });
    [...this.upper, ...this.rough, ...this.under].forEach((t) => (t.needsUpdate = true));
    // Map the painted hue (190–215) onto the interference peak (~510–490 nm; photos read cyan-blue).
    for (const m of this.upperMats) m.lambda0.value = 510 - (this.pattern.hue - 190) * 0.8;
  }

  // angle: 0 = wings flat, positive = raised toward closed above the back.
  // twist: rotation about the wing's span, positive = leading edge up (supination).
  // lean: the right pair raised and the left lowered by this much, fading out as the wings close
  // (closed wings press together and would cross).
  setWings(angle, hindAngle = angle, twist = 0, lean = 0) {
    const open = 1 - THREE.MathUtils.smoothstep(angle, 1.1, 1.5);
    for (const p of this.pivots) {
      const a = (p.userData.hind ? hindAngle : angle) + p.userData.side * lean * open;
      // Flap about the body axis first, then twist about the raised wing's span.
      p.rotation.order = 'YXZ';
      p.rotation.y = -p.userData.side * a;
      p.rotation.x = twist * (p.userData.hind ? 0.6 : 1);
      // Closed wings press flat against each other; with full camber (~2 mm) the two wings,
      // only 3 mm apart at the root, cross and the far wing's blue upperside shows through.
      const flat = THREE.MathUtils.smoothstep(a, 1.1, 1.5);
      for (const w of p.children) w.scale.z = 1 - 0.9 * flat;
    }
  }
}
