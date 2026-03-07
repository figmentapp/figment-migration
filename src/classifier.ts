import type { NodeClassification } from "./types";

const WEBGL_MARKERS = [
  "gl_FragColor",
  "texture2D(",
  "varying vec2 v_uv",
  "precision mediump float",
  "figment.createShaderProgram(",
  "new figment.Framebuffer(",
  "framebuffer.bind()",
  "figment.drawQuad(",
  "figment.clear()",
];

export function hasWebGLMarkers(source: string): boolean {
  return WEBGL_MARKERS.some((marker) => source.includes(marker));
}

export function classifyNode(source: string): NodeClassification {
  const imageInCount = (source.match(/node\.imageIn\(/g) || []).length;
  const imageOutCount = (source.match(/node\.imageOut\(/g) || []).length;
  const programCount = (
    source.match(/figment\.createShaderProgram\(/g) || []
  ).length;

  const hasPingPong =
    /pingPong/i.test(source) ||
    /u_prev_texture/.test(source) ||
    /new figment\.Framebuffer\(\).*new figment\.Framebuffer\(\)/s.test(source);

  const hasIterLoop = /for\s*\(.*iteration/i.test(source);

  const hasWidthHeight =
    /node\.numberIn\(\s*['"]width/i.test(source) &&
    /node\.numberIn\(\s*['"]height/i.test(source);

  if (programCount > 1) return "raw";
  if (imageInCount > 1) return "raw";
  if (imageInCount === 0 && hasWidthHeight) return "generator";
  if (hasPingPong || hasIterLoop) return "feedback";
  if (imageInCount === 1 && imageOutCount === 1) return "filter";
  return "raw";
}
