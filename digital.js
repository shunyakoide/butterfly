import { uniform, screenUV, screenSize, time, vec2, vec3, mix, step, smoothstep, max, min, hash, sqrt, equal, sin, cos } from 'three/tsl';
import { heat } from './fx.js';

// The butterfly redrawn: a green dot-matrix dither, a blue halftone of big dots, black pixel marks
// on white (a dot, a cross or a square per cell, by darkness), liquid chrome, a flickering hologram,
// contour lines or a thermal camera. Only the butterfly's pixels change (a mask written by its
// materials in the scene pass); the print styles read the frame in square cells at their centres, so
// their silhouette turns blocky. Separately, on take-off the butterfly breaks into blocks that stream
// off sideways and thin out.

export const STYLES = ['dots', 'halftone', 'pixels', 'chrome', 'holo', 'topo', 'thermal'];
const CELL = { dots: [3, 3], halftone: [9, 9], pixels: [6, 6] }; // CSS px; the rest work per pixel
const COLOUR = { dots: vec3(0.3, 1, 0.35), halftone: vec3(0.05, 0.35, 1), holo: vec3(0.25, 0.95, 1) };
const SCATTER_TIME = 0.9; // s the take-off break-up lasts
const brightness = (c) => max(c.r, max(c.g, c.b)); // the saturated blue reads dark in luminance

// pixelRatio: the renderer's, so the print cells keep their size in CSS pixels.
export function buildDigital({ pixelRatio, colour, smooth, mask }) {
  const dpr = uniform(1), scatter = uniform(0);

  function print(base, style) {
    const P = screenUV.mul(screenSize); // physical px
    const cellPx = vec2(...(CELL[style] ?? [1, 1])).mul(dpr);
    const cell = P.div(cellPx).floor(), local = P.div(cellPx).fract();
    const dither = hash(cell.x.add(cell.y.mul(4096))); // a random threshold per cell
    const uv = cell.add(0.5).mul(cellPx).div(screenSize);
    const on = step(0.5, mask.sample(uv).r);
    const c = colour.sample(uv).rgb;
    const t = smoothstep(0.02, 0.6, brightness(c));
    // The black-and-white styles take a softer ramp (power 0.7), so the shadowed wing keeps its steps too.
    const ink = brightness(c).clamp(0, 1).pow(0.7).oneMinus();
    let out;
    if (style === 'dots') {
      // A square dot per cell, lit when brighter than a random threshold (a stochastic dither).
      const lit = step(dither, t);
      const square = step(0.15, local.x).mul(step(local.x, 0.85)).mul(step(0.15, local.y)).mul(step(local.y, 0.85));
      out = COLOUR.dots.mul(lit.mul(square)).mul(t.mul(0.6).add(0.4));
    } else if (style === 'halftone') {
      const r = sqrt(t).mul(0.56);
      out = COLOUR.halftone.mul(smoothstep(r, r.sub(0.08), local.sub(0.5).length())).mul(1.3);
    } else if (style === 'pixels') {
      // On a 3×3 grid per cell (plus a gutter, so even the darkest stays a grid of squares): nothing,
      // a centre dot, a cross, or the whole square, by darkness with a random nudge so the steps
      // dither into each other.
      const level = min(ink.mul(3).add(dither).floor(), 3);
      const sub = local.mul(4).floor(), mid = (a) => equal(a, 1).select(1, 0);
      const mark = mid(sub.x).mul(mid(sub.y)).mul(step(1, level))
        .max(mid(sub.x).max(mid(sub.y)).mul(step(2, level))).max(step(3, level)).mul(step(sub.x, 2)).mul(step(sub.y, 2));
      out = mix(vec3(0.9), vec3(0.02), mark);
    } else if (style === 'chrome') {
      // Brightness read through a slowly wobbling lens and folded into chrome bands: black, silver-blue,
      // white glints, and a thin orange rim where a band turns dark.
      const wobble = vec2(sin(P.y.div(dpr.mul(37)).add(time.mul(0.8))), sin(P.x.div(dpr.mul(53)).sub(time.mul(0.6)))).mul(dpr.mul(6));
      const w = colour.sample(P.add(wobble).div(screenSize)).rgb;
      // The darkest tenth stays black; the bands breathe slowly, from the dark end, so the black holds still.
      const lift = brightness(w).sub(0.1).clamp(0, 1);
      const band = cos(lift.mul(sin(time.mul(0.3)).mul(0.15).add(1.8)).mul(6.283)).mul(-0.5).add(0.5);
      const rim = smoothstep(0.12, 0.22, band).sub(smoothstep(0.22, 0.34, band));
      out = mix(vec3(0.01), vec3(0.62, 0.74, 0.9), smoothstep(0.45, 0.9, band))
        .add(smoothstep(0.88, 0.98, band)).add(vec3(1, 0.42, 0.08).mul(rim).mul(1.5));
    } else if (style === 'holo') {
      // A see-through cyan projection: scan lines every 3 px, a band of light rolling down, and now
      // and then a strip of rows jumping sideways for a few frames.
      const row = P.y.div(dpr.mul(24)).floor();
      const jump = step(0.94, hash(row.add(time.mul(9).floor().mul(131)))).mul(hash(row.add(7)).sub(0.5)).mul(dpr.mul(40));
      const h = colour.sample(P.add(vec2(jump, 0)).div(screenSize)).rgb;
      const lines = sin(P.y.div(dpr).mul(2.1)).mul(0.45).add(0.55);
      const roll = smoothstep(0.92, 1, sin(P.y.div(screenSize.y).mul(3).sub(time.mul(1.5))).mul(0.5).add(0.5)).mul(0.5);
      out = COLOUR.holo.mul(smoothstep(0.08, 0.7, brightness(h)).pow(1.5).mul(0.9).add(0.04).add(roll)).mul(lines);
    } else if (style === 'topo') {
      // Contour lines: where the brightness, cut into 10 levels, steps between this pixel and the next.
      // Read from the blurred frame, or the wing's fine shimmer breaks into lines everywhere.
      const level = (p) => brightness(smooth.sample(p.div(screenSize)).rgb).clamp(0, 1).pow(0.6).mul(10).floor();
      const l0 = level(P), edge = max(l0.notEqual(level(P.add(vec2(dpr, 0)))).select(1, 0), l0.notEqual(level(P.add(vec2(0, dpr)))).select(1, 0));
      out = vec3(0.01).add(vec3(0.85, 0.95, 1).mul(edge)).add(vec3(0.05, 0.12, 0.2).mul(l0.div(10)));
    } else {
      out = heat(brightness(c).clamp(0, 1).pow(0.6)); // thermal
    }
    return mix(base, out, on);
  }

  // Take-off break-up: rows of 5 px blocks slide off at their own speed, the blocks thinning out.
  function scattered(image) {
    const P = screenUV.mul(screenSize), B = dpr.mul(5);
    const row = P.y.div(B).floor();
    const src = P.sub(vec2(scatter.mul(hash(row.add(3)).mul(160).add(40)).mul(dpr), 0));
    const block = src.div(B).floor();
    const keep = step(scatter.mul(1.1), hash(block.x.add(block.y.mul(4096)).add(9e5))).mul(step(0.001, scatter));
    const uv = src.div(screenSize);
    return mix(image, colour.sample(uv).rgb, step(0.5, mask.sample(uv).r).mul(keep));
  }

  function apply(base, style) {
    return scattered(style ? print(base, style) : base);
  }

  let prevMode = null, since = Infinity;
  function update(dt, mode) {
    dpr.value = pixelRatio();
    if (mode === 'takeoff' && prevMode === 'rest') since = 0;
    prevMode = mode;
    since += dt;
    scatter.value = since < SCATTER_TIME ? since / SCATTER_TIME : 0;
  }

  return { apply, update };
}
