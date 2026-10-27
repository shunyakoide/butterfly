import * as THREE from 'three/webgpu';
import { texture, uv, vec2, vec3, vec4, float, uniform, mix, exp, sqrt, length, atan, floor, fract, hash, fwidth, smoothstep, dFdx, dFdy, sin, normalView, positionViewDirection, tangentView, bitangentView } from 'three/tsl';
import { BOX } from './wing.js';

// Wing material: standard PBR plus
//  - the morpho's structural blue: an anisotropic reflection lobe whose hue follows thin-film
//    interference (blue at normal incidence, shifting to violet and fading off-angle), on a dark
//    melanin base;
//  - translucency: light from behind the wing shows the other side's colours through it.
//
// Optics, from Vukusic 1999 (doi:10.1098/rspb.1999.0794), Giraldo & Stavenga 2016
// (doi:10.1007/s00359-016-1084-1) and Sosa Espinosa 2024/2026 (M. helenor, which includes peleides):
//  - peak ~460 nm (≈220 nm chitin film, n ≈ 1.56); the peak moves to shorter wavelengths off-normal;
//  - scale ridges diffract light widely in the plane across the ridges (>100°) and narrowly along
//    them; on the whole M. helenor wing the narrow plane still spans ~61° (curved cover scales);
//  - melanin under the multilayer absorbs the rest, so away from the lobe the wing looks dark;
//  - two reflections, ~25° apart (Giraldo & Stavenga 2016): the cover scale's flat lower lamina
//    (a 220 nm film) gives a short near-specular spot, and its ridges, whose lamellae are tilted
//    ~12°, give the broad band;
//  - the unpigmented cover scales add red at oblique angles (~60°), so the blue whitens there.
// Ridges run along each scale, and scales point from the root toward the margin.

// Spreads of the ridge band, in tan of the half-vector angle. Along the ridges: M. helenor's ~61°
// FWHM of the reflected light (Sosa Espinosa 2026); across: >100° (Vukusic 1999).
const SIGMA_ALONG = 0.32;
const SIGMA_ACROSS = 0.55;
const SIGMA_LAMINA = 0.12;  // the lower lamina's near-specular spot (~±7°)
const LAMINA = 0.5;         // its strength relative to the ridge band
const N_EFF = 1.56;         // chitin index; a lower effective index shifted photos-blue too far to violet
// The ridge lamellae are tilted ~12° against the scale (M. helenor, Giraldo & Stavenga 2016), so
// the band leans off the wing normal along the ridges.
// shortcut: no paper we could read gives the direction (toward the tip or the base); the margin
// side is a guess. Sosa Espinosa's thesis (embargoed to 2026-11-11) should settle it; flip if wrong.
const LAMELLA_TILT = THREE.MathUtils.degToRad(12);

// Scales, in wing-model meters (the model is drawn at 1/1.3 size). The blue is not one plate: it is
// thousands of separate scales, overlapping like roof tiles in rows across the wing, each one a
// little curved and set at its own angle. Every scale reflects its own patch of the band, so the
// rows light up at different places as the view moves (the fine wavy "watered silk" lines in macro
// photos) and single scales glint.
// M. peleides scales are 157–216 x 107–137 µm (doi:10.3390/biomimetics10020089); helenor cover
// scales are half-curved, so spots along one scale reflect in clearly different directions, while
// the ground scales are flat (Sosa Espinosa 2024, doi:10.1098/rsbl.2024.0358). Random tilt between
// neighbouring scales broadens the band by ~20° (M. aega, Vukusic-era scatterometry,
// doi:10.1007/s00359-007-0297-8).
const ROW = 0.00007;                 // row spacing: ~90 µm real, scales overlap by about half
const SCALE_WID = 0.000092;          // ~120 µm real
const CURL = 0.25;                   // est.: tan of the tilt change from base to tip (~14°)
const JITTER = 0.07;                 // tan of the scale-to-scale scatter (~4°, i.e. ~20° FWHM in the reflection)
// The rows are not straight: neighbouring rows lean together in wavy bands a few rows wide, which
// is the fingerprint-like rippling that macro photos of morpho wings show.
const RIPPLE = 0.00022;              // band spacing
const RIPPLE_TILT = 0.15;            // est.: tan of the tilt swing across a band
// Coarser swells of several bands (~0.6 mm real), big enough to read at the normal viewing
// distance, where single rows are below a pixel.
const SWELL = 0.00045;
const SWELL_TILT = 0.15;             // est.
// The wing-level spread along the ridges (SIGMA_ALONG, ~61° FWHM) already includes all of the above,
// so the band of a single patch of scale is narrower by their combined variance.
const SCALE_VAR = (CURL * CURL) / 12 + JITTER * JITTER + (RIPPLE_TILT * RIPPLE_TILT + SWELL_TILT * SWELL_TILT) / 2;
const SIGMA_ALONG_1 = Math.sqrt(SIGMA_ALONG * SIGMA_ALONG - SCALE_VAR);
// Four rotated-grid sub-samples per pixel; scales below pixel size widen the band instead of
// aliasing (their scatter of tilts averages into a broader lobe).
const SUBSAMPLES = [[-0.125, -0.375], [0.375, -0.125], [0.125, 0.375], [-0.375, 0.125]];

// Smooth 2D value noise in [0, 1].
function vnoise(x, y) {
  const ix = floor(x), iy = floor(y), fx = smoothstep(0, 1, fract(x)), fy = smoothstep(0, 1, fract(y));
  const h = (dx, dy) => hash(ix.add(dx).mul(7919).add(iy.add(dy)).add(1e6));
  return mix(mix(h(0, 0), h(1, 0), fx), mix(h(0, 1), h(1, 1), fx), fy);
}

// ---------- spectral lookup: reflectance band centre (nm) -> linear sRGB ----------

// CIE 1931 colour matching functions, multi-lobe Gaussian fit (Wyman, Sloan & Shirley 2013).
function cmf(l) {
  const g = (mu, s1, s2) => Math.exp(-0.5 * ((l - mu) / (l < mu ? s1 : s2)) ** 2);
  return [
    1.056 * g(599.8, 37.9, 31.0) + 0.362 * g(442.0, 16.0, 26.7) - 0.065 * g(501.1, 20.4, 26.2),
    0.821 * g(568.8, 46.9, 40.5) + 0.286 * g(530.9, 16.3, 31.1),
    1.217 * g(437.0, 11.8, 36.0) + 0.681 * g(459.0, 26.0, 13.8),
  ];
}
// Colour of a reflectance band ~90 nm wide (FWHM) centred on `centre`.
function bandRGB(centre) {
  const xyz = [0, 0, 0];
  for (let l = 360; l <= 760; l += 5) {
    const w = Math.exp(-0.5 * ((l - centre) / 38) ** 2), c = cmf(l);
    for (let k = 0; k < 3; k++) xyz[k] += w * c[k];
  }
  const [X, Y, Z] = xyz;
  return [3.2406 * X - 1.5372 * Y - 0.4986 * Z, -0.9689 * X + 1.8758 * Y + 0.0415 * Z, 0.0557 * X - 0.204 * Y + 1.057 * Z]
    .map((v) => Math.max(0, v));
}
const LUT_MIN = 300, LUT_RANGE = 400, LUT_SIZE = 256;
function spectralLUT() {
  const norm = Math.max(...bandRGB(460));
  const data = new Uint8Array(LUT_SIZE * 4);
  for (let i = 0; i < LUT_SIZE; i++) {
    const rgb = bandRGB(LUT_MIN + LUT_RANGE * i / (LUT_SIZE - 1)).map((v) => Math.min(1, v / norm));
    data.set([...rgb.map((v) => v * 255), 255], i * 4);
  }
  const t = new THREE.DataTexture(data, LUT_SIZE, 1);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}
const LUT = spectralLUT();

// Interference colour at angle θ inside the lamellae: λ = λ0·sqrt(1 − sin²θ / n²).
function interference(cosTheta, lambda0) {
  const lam = lambda0.mul(sqrt(cosTheta.mul(cosTheta).oneMinus().div(N_EFF * N_EFF).oneMinus()));
  return texture(LUT, vec2(lam.sub(LUT_MIN).div(LUT_RANGE), 0.5)).rgb;
}

// Cover scales whiten the colour at oblique angles, by up to 60% beyond ~65°: toward a pale cyan
// grey of the same peak brightness (photos show silvery cyan there, not the violet the film shift
// alone gives).
function oblique(rgb, cosTheta) {
  const peak = rgb.x.max(rgb.y).max(rgb.z);
  return mix(rgb, vec3(0.72, 0.84, 0.95).mul(peak), smoothstep(0.85, 0.4, cosTheta).mul(0.6));
}

class WingLightingModel extends THREE.PhysicalLightingModel {
  direct(data, builder) {
    super.direct(data, builder);
    const m = builder.material;
    const { lightDirection: L, lightColor, reflectedLight } = data;
    const N = normalView;
    const V = positionViewDirection;
    // Translucency, strongest looking into the light: the membrane and scales scatter forward.
    const forward = V.dot(L.negate()).clamp().pow(4).mul(2.4).add(0.6);
    reflectedLight.directDiffuse.addAssign(N.dot(L).negate().clamp().mul(forward).mul(lightColor).mul(m.transColor));
    if (!m.structural) return;
    const H = L.add(V).normalize();
    const T0 = m.ridgeDir.sub(N.mul(N.dot(m.ridgeDir))).normalize(), B = N.cross(T0);
    // Lamella frame: the surface frame rotated about B by the lamella tilt.
    const c = Math.cos(LAMELLA_TILT), s = Math.sin(LAMELLA_TILT);
    const Nl = N.mul(c).add(T0.mul(s)), T = T0.mul(c).sub(N.mul(s));
    const hn = H.dot(Nl).max(1e-3), hn0 = H.dot(N).max(1e-3);
    const hT = H.dot(T).div(hn), hB = H.dot(B).div(hn), h0T = H.dot(T0).div(hn0), h0B = H.dot(B).div(hn0);
    // Scales too small to resolve: their spread of tilts widens the band rather than aliasing.
    const blur = m.scaleVis.oneMinus().mul((CURL * CURL) / 12 + JITTER * JITTER)
      .add(m.rippleVis.oneMinus().mul((RIPPLE_TILT * RIPPLE_TILT) / 2))
      .add(m.swellVis.oneMinus().mul((SWELL_TILT * SWELL_TILT) / 2));
    const sAlong = blur.add(SIGMA_ALONG_1 * SIGMA_ALONG_1).sqrt(), sAcross = blur.add(SIGMA_ACROSS * SIGMA_ACROSS).sqrt();
    const sLamina = blur.add(SIGMA_LAMINA * SIGMA_LAMINA);
    let lobe = float(0);
    for (const j of m.scaleSamples) {
      // Each scale's tilt shifts where its band and its lamina spot sit.
      const tT = hT.add(j.x).div(sAlong), tB = hB.add(j.y).div(sAcross);
      const band = exp(tT.mul(tT).add(tB.mul(tB)).negate());
      // The lamina spot is centred on the untilted normal.
      const sA = h0T.add(j.x), sB = h0B.add(j.y);
      const spot = exp(sA.mul(sA).add(sB.mul(sB)).div(sLamina).negate()).mul(LAMINA);
      lobe = lobe.add(band.add(spot).mul(j.z));
    }
    lobe = lobe.div(m.scaleSamples.length);
    reflectedLight.directSpecular.addAssign(
      oblique(interference(L.dot(H), m.lambda0), L.dot(H)).mul(lobe)
        .mul(N.dot(L).clamp()).mul(lightColor).mul(m.blueMask).mul(m.lobeStrength));
  }

  indirect(builder) {
    super.indirect(builder);
    const m = builder.material;
    if (!m.structural) return;
    const { radiance, reflectedLight } = builder.context;
    reflectedLight.indirectSpecular.addAssign(
      radiance.mul(oblique(interference(normalView.dot(positionViewDirection).clamp(), m.lambda0), normalView.dot(positionViewDirection).clamp())).mul(m.blueMask).mul(m.envStrength).mul(m.scaleStrength));
  }
}

export class WingMaterial extends THREE.MeshPhysicalNodeMaterial {
  // structural: add the blue lobe, using roughMap's green channel (0.92 - 0.6·blue) as the mask.
  // transMap/transStrength: colour seen through the wing when lit from behind; shadeMap: the other
  // scale layer, whose dark parts (the chocolate border) block the light (refs under-5).
  constructor({ structural = false, roughMap = null, transMap, shadeMap, transStrength, ...params }) {
    super(params);
    this.structural = structural;
    // Not named *Node: NodeMaterial already uses maskNode (it discards fragments) and friends.
    this.blueMask = structural ? texture(roughMap).g.oneMinus().sub(0.08).div(0.6).clamp() : float(0);
    const shade = texture(shadeMap).rgb.dot(vec3(0.2126, 0.7152, 0.0722)).mul(3).clamp(0.15, 1);
    this.transColor = texture(transMap).rgb.mul(shade).mul(transStrength);
    this.lambda0 = uniform(460);
    this.lobeStrength = uniform(1.3);
    this.envStrength = uniform(0.6);
    // Ridge direction: radial from the wing root, in the wing's tangent frame.
    const d = uv().mul(BOX.size).add(vec2(BOX.x0, BOX.y0)).normalize();
    this.ridgeDir = tangentView.mul(d.x).add(bitangentView.mul(d.y)).normalize();
    // Scales: rows run across the wing (rings around the root, wavy and irregular as in macro
    // photos); within a row, scales sit side by side, offset half a scale from the next row.
    const p = uv().mul(BOX.size).add(vec2(BOX.x0, BOX.y0));
    const dx = dFdx(p), dy = dFdy(p);
    const footprint = fwidth(p.x).add(fwidth(p.y)).max(1e-9);
    // 1 when a row spans a few pixels (close up), 0 when many rows share a pixel.
    this.scaleVis = smoothstep(0.15, 1, float(ROW).div(footprint));
    this.rippleVis = smoothstep(0.3, 1.5, float(RIPPLE).div(footprint));
    this.swellVis = smoothstep(0.3, 1.5, float(SWELL).div(footprint));
    // Broad streaks and watery patches across many scales (visible at any distance).
    const rad0 = length(p), arc0 = atan(p.y, p.x).mul(rad0);
    const streak = vnoise(arc0.div(0.0005), rad0.div(0.004)).mul(0.35).add(vnoise(arc0.div(0.003), rad0.div(0.006)).mul(0.65));
    this.scaleStrength = mix(float(0.72), float(1.28), streak);
    this.scaleSamples = SUBSAMPLES.map(([ox, oy]) => {
      const q = p.add(dx.mul(ox)).add(dy.mul(oy));
      const rad = length(q), arc = atan(q.y, q.x).mul(rad);
      const wave = vnoise(arc.div(0.0007), rad.div(0.0015)).sub(0.5).mul(ROW * 3)
        .add(sin(arc.div(0.0012)).mul(ROW * 0.6));
      const r = rad.add(wave).div(ROW), row = floor(r), along = fract(r);
      const col = floor(arc.div(SCALE_WID).add(row.mul(0.5)));
      const id = row.mul(7919).add(col).add(1e5);
      const vis = this.scaleVis;
      const ripple = sin(rad.add(wave.mul(2.5)).div(RIPPLE).mul(Math.PI * 2)).mul(RIPPLE_TILT).mul(this.rippleVis);
      // The swells also shade: scales on the far side of a swell sit partly in the next one's lee.
      const swellPhase = rad.add(wave.mul(5)).div(SWELL).mul(Math.PI * 2);
      const swell = sin(swellPhase).mul(SWELL_TILT).mul(this.swellVis);
      const swellShade = sin(swellPhase.add(1.2)).mul(0.15).mul(this.swellVis).add(1);
      return vec3(
        // Tilt along the scale: curved from base (along = 0) to tip, plus its own setting angle,
        // plus the wavy band its row belongs to.
        along.sub(0.5).mul(CURL).add(hash(id).sub(0.5).mul(JITTER * 3.4)).mul(vis).add(ripple).add(swell),
        hash(id.add(1)).sub(0.5).mul(JITTER * 3.4).mul(vis),
        // Brightness: each scale a little different; the tip edge of each row shades the next.
        this.scaleStrength.mul(swellShade).mul(mix(float(1), hash(id.add(2)).mul(0.6).add(0.7).mul(smoothstep(0, 0.12, along).mul(0.3).add(0.7)), vis)));
    });
    if (structural) {
      // Under the blue scales the diffuse base is mostly melanin; the blue comes from the lobe.
      const base = texture(params.map);
      this.colorNode = vec4(base.rgb.mul(mix(float(1), float(0.4), this.blueMask)), base.a);
      // The chitin surface glare stays broad: ridges and crossribs make the scales rough at the
      // micro scale, and a glossier value turned the wing into a white mirror at grazing angles.
      this.roughnessNode = mix(float(0.92), float(0.65), this.blueMask);
      // Silvery haze: the unpigmented cover scales scatter a pale, barely blue light widely, which
      // takes over at oblique views where the blue band is out of sight (photos: refs oblique-1).
      this.haze = uniform(1.2);
      this.sheenNode = vec3(0.6, 0.75, 0.86).mul(this.blueMask).mul(this.haze);
      this.sheenRoughnessNode = float(0.8);
    }
  }

  setupLightingModel() {
    return new WingLightingModel(this.useClearcoat, this.useSheen, this.useIridescence, this.useAnisotropy,
      this.useTransmission, this.useDispersion, this.useRetroreflection);
  }
}
