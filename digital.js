import * as THREE from 'three/webgpu';
import { uniform, texture, screenUV, screenSize, time, vec2, vec3, mix, step, smoothstep, max, hash, sqrt } from 'three/tsl';

// The butterfly redrawn as a screen print: a green dot-matrix dither, a blue halftone of big dots,
// or ASCII characters on blue. Only the butterfly's pixels change (a mask written by its materials
// in the scene pass), in square cells read from the rendered frame at their centre, so its silhouette
// turns blocky. It shows in square blocks at random places that keep changing, so the print covers the
// whole butterfly at times and only scattered parts of it at others.

export const STYLES = ['dots', 'halftone', 'ascii'];
const CELL = { dots: [3, 3], halftone: [9, 9], ascii: [7, 11] }; // CSS px
const BLOCK = 48; // CSS px, the squares the print shows in
const GLYPHS = ' .:-=+*#%@';
const COLOUR = { dots: vec3(0.3, 1, 0.35), halftone: vec3(0.05, 0.35, 1), ascii: vec3(0.85, 0.92, 1) };

// The character set, drawn in code into one row of cells.
function glyphAtlas() {
  const W = 16, H = 24, c = document.createElement('canvas');
  c.width = W * GLYPHS.length; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.font = `bold ${H - 4}px ui-monospace, Menlo, monospace`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  [...GLYPHS].forEach((g, i) => ctx.fillText(g, i * W + W / 2, H / 2 + 1));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

export function buildDigital({ colour, mask }) {
  const dpr = uniform(1), coverage = uniform(1);
  const atlas = glyphAtlas();

  function apply(base, style) {
    const P = screenUV.mul(screenSize); // physical px
    const cellPx = vec2(...CELL[style]).mul(dpr);
    const cell = P.div(cellPx).floor(), local = P.div(cellPx).fract();
    const at = cell.add(0.5).mul(cellPx);
    const uv = at.div(screenSize);
    const on = step(0.5, mask.sample(uv).r);
    // Brightness as the strongest channel: the saturated blue reads dark in luminance.
    const c = colour.sample(uv).rgb;
    const t = smoothstep(0.02, 0.6, max(c.r, max(c.g, c.b)));
    let print;
    if (style === 'dots') {
      // A square dot per cell, lit when brighter than a random threshold (a stochastic dither).
      const lit = step(hash(cell.x.add(cell.y.mul(4096))), t);
      const square = step(0.15, local.x).mul(step(local.x, 0.85)).mul(step(0.15, local.y)).mul(step(local.y, 0.85));
      print = COLOUR.dots.mul(lit.mul(square)).mul(t.mul(0.6).add(0.4));
    } else if (style === 'halftone') {
      const r = sqrt(t).mul(0.56);
      print = COLOUR.halftone.mul(smoothstep(r, r.sub(0.08), local.sub(0.5).length())).mul(1.3);
    } else {
      const n = GLYPHS.length, idx = t.mul(n - 0.001).floor();
      const g = texture(atlas, vec2(idx.add(local.x).div(n), local.y.oneMinus())).r;
      print = mix(vec3(0.12, 0.27, 0.7), COLOUR.ascii, g);
    }
    // Each block (picked by its cells' centres, so cells stay whole) draws a new chance on its own
    // ~1.7 s beat, and shows the print while that is under the coverage.
    const block = at.div(dpr.mul(BLOCK)).floor(), id = block.x.add(block.y.mul(1024)).add(4096);
    const beat = time.mul(0.6).add(hash(id)).floor();
    const covered = step(hash(id.add(beat.mul(65536))), coverage);
    return mix(base, print, on.mul(covered));
  }

  function update(t) {
    dpr.value = Math.min(devicePixelRatio, 2);
    // A few blocks, then about half, then all of it (held a while), on a 16 s cycle.
    coverage.value = THREE.MathUtils.clamp(0.45 + 0.65 * Math.sin(t * Math.PI / 8), 0.12, 1);
  }

  return { apply, update };
}
