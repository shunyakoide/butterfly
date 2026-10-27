import * as THREE from 'three/webgpu';
import { uniform, screenUV, screenSize, time, vec2, vec3, mix, step, smoothstep, max, min, hash, sqrt, equal, sin, cos } from 'three/tsl';

// The butterfly redrawn as a screen print: a green dot-matrix dither, a blue halftone of big dots,
// black pixel marks on white (a dot, a cross or a square per cell, by darkness), liquid chrome, or
// diagonal dashes on grey, thicker where darker. Only the butterfly's pixels change (a mask written by its materials
// in the scene pass), in square cells read from the rendered frame at their centre, so its silhouette
// turns blocky.

export const STYLES = ['dots', 'halftone', 'pixels', 'chrome', 'dashes'];
const CELL = { dots: [3, 3], halftone: [9, 9], pixels: [6, 6], chrome: [1, 1], dashes: [16, 8] }; // CSS px (dashes: along, across)
const COLOUR = { dots: vec3(0.3, 1, 0.35), halftone: vec3(0.05, 0.35, 1) };
const S = Math.SQRT1_2;

export function buildDigital({ colour, mask }) {
  const dpr = uniform(1);

  function apply(base, style) {
    const P = screenUV.mul(screenSize); // physical px
    const cellPx = vec2(...CELL[style]).mul(dpr);
    // Dashes run on a grid turned 45° (along "/"), the rest on the screen's.
    const turn = style === 'dashes';
    const Q = turn ? vec2(P.x.sub(P.y), P.x.add(P.y)).mul(S) : P;
    const cell = Q.div(cellPx).floor(), local = Q.div(cellPx).fract();
    const qc = cell.add(0.5).mul(cellPx);
    const at = turn ? vec2(qc.x.add(qc.y), qc.y.sub(qc.x)).mul(S) : qc;
    const uv = at.div(screenSize);
    const on = step(0.5, mask.sample(uv).r);
    // Brightness as the strongest channel: the saturated blue reads dark in luminance.
    const c = colour.sample(uv).rgb;
    const t = smoothstep(0.02, 0.6, max(c.r, max(c.g, c.b)));
    // The black-and-white styles take a softer ramp (power 0.7), so the shadowed wing keeps its steps too.
    const ink = max(c.r, max(c.g, c.b)).clamp(0, 1).pow(0.7).oneMinus();
    let print;
    if (style === 'dots') {
      // A square dot per cell, lit when brighter than a random threshold (a stochastic dither).
      const lit = step(hash(cell.x.add(cell.y.mul(4096))), t);
      const square = step(0.15, local.x).mul(step(local.x, 0.85)).mul(step(0.15, local.y)).mul(step(local.y, 0.85));
      print = COLOUR.dots.mul(lit.mul(square)).mul(t.mul(0.6).add(0.4));
    } else if (style === 'halftone') {
      const r = sqrt(t).mul(0.56);
      print = COLOUR.halftone.mul(smoothstep(r, r.sub(0.08), local.sub(0.5).length())).mul(1.3);
    } else if (style === 'pixels') {
      // On a 3×3 grid per cell (plus a gutter, so even the darkest stays a grid of squares): nothing,
      // a centre dot, a cross, or the whole square, by darkness with a random nudge so the steps
      // dither into each other.
      const level = min(ink.mul(3).add(hash(cell.x.add(cell.y.mul(4096)))).floor(), 3);
      const sub = local.mul(4).floor(), mid = (a) => equal(a, 1).select(1, 0);
      const mark = mid(sub.x).mul(mid(sub.y)).mul(step(1, level))
        .max(mid(sub.x).max(mid(sub.y)).mul(step(2, level))).max(step(3, level)).mul(step(sub.x, 2)).mul(step(sub.y, 2));
      print = mix(vec3(0.9), vec3(0.02), mark);
    } else if (style === 'chrome') {
      // Brightness read through a slowly wobbling lens and folded into chrome bands: black, silver-blue,
      // white glints, and a thin orange rim where a band turns dark.
      const wobble = vec2(sin(P.y.div(dpr.mul(37)).add(time.mul(0.8))), sin(P.x.div(dpr.mul(53)).sub(time.mul(0.6)))).mul(dpr.mul(6));
      const w = colour.sample(P.add(wobble).div(screenSize)).rgb;
      // The darkest tenth stays black; the bands breathe slowly, from the dark end, so the black holds still.
      const lift = max(w.r, max(w.g, w.b)).sub(0.1).clamp(0, 1);
      const band = cos(lift.mul(sin(time.mul(0.3)).mul(0.15).add(1.8)).mul(6.283)).mul(-0.5).add(0.5);
      const rim = smoothstep(0.12, 0.22, band).sub(smoothstep(0.22, 0.34, band));
      print = mix(vec3(0.01), vec3(0.62, 0.74, 0.9), smoothstep(0.45, 0.9, band))
        .add(smoothstep(0.88, 0.98, band)).add(vec3(1, 0.42, 0.08).mul(rim).mul(1.5));
    } else {
      // A dash along each cell, thicker where darker.
      const half = ink.mul(ink).mul(0.36).add(0.05);
      const dash = step(local.x.sub(0.5).abs(), 0.36).mul(step(local.y.sub(0.5).abs(), half));
      print = mix(vec3(0.55), vec3(0.04), dash);
    }
    return mix(base, print, on);
  }

  function update() {
    dpr.value = Math.min(devicePixelRatio, 2);
  }

  return { apply, update };
}
