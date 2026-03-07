import { describe, it, expect } from "vitest";
import { hasWebGLMarkers, classifyNode } from "./classifier";

describe("hasWebGLMarkers", () => {
  it("detects WebGL code", () => {
    const source = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_texture;
void main() {
  gl_FragColor = texture2D(u_texture, v_uv);
}
`;
    expect(hasWebGLMarkers(source)).toBe(true);
  });

  it("detects figment WebGL helpers", () => {
    const source = `
const program = figment.createShaderProgram(vertexSrc, fragmentSrc);
const fb = new figment.Framebuffer(512, 512);
fb.bind();
figment.drawQuad(program);
figment.clear();
`;
    expect(hasWebGLMarkers(source)).toBe(true);
  });

  it("returns false for WebGPU code", () => {
    const source = `
const adapter = await navigator.gpu.requestAdapter();
const device = await adapter.requestDevice();
const shaderModule = device.createShaderModule({
  code: \`
    @vertex fn vs(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4f {
      return vec4f(0.0, 0.0, 0.0, 1.0);
    }
    @fragment fn fs() -> @location(0) vec4f {
      return vec4f(1.0, 0.0, 0.0, 1.0);
    }
  \`
});
`;
    expect(hasWebGLMarkers(source)).toBe(false);
  });

  it("returns false for plain JS code", () => {
    const source = `
function add(a, b) { return a + b; }
console.log(add(1, 2));
`;
    expect(hasWebGLMarkers(source)).toBe(false);
  });
});

describe("classifyNode", () => {
  it('returns "filter" for single-input/output filter code', () => {
    const source = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_texture;
void main() {
  vec4 color = texture2D(u_texture, v_uv);
  gl_FragColor = vec4(1.0 - color.rgb, color.a);
}

export default function setup(node) {
  const imageIn = node.imageIn("image");
  const imageOut = node.imageOut("output");
  const program = figment.createShaderProgram(vertexSrc, fragmentSrc);
  figment.drawQuad(program);
}
`;
    expect(classifyNode(source)).toBe("filter");
  });

  it('returns "generator" for no-input code with width/height params', () => {
    const source = `
precision mediump float;
varying vec2 v_uv;
uniform float u_time;
void main() {
  gl_FragColor = vec4(v_uv, sin(u_time) * 0.5 + 0.5, 1.0);
}

export default function setup(node) {
  const width = node.numberIn('width', 512);
  const height = node.numberIn('height', 512);
  const imageOut = node.imageOut("output");
  const program = figment.createShaderProgram(vertexSrc, fragmentSrc);
  figment.drawQuad(program);
}
`;
    expect(classifyNode(source)).toBe("generator");
  });

  it('returns "feedback" for ping-pong code', () => {
    const source = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_prev_texture;
void main() {
  vec4 prev = texture2D(u_prev_texture, v_uv);
  gl_FragColor = prev * 0.99;
}

export default function setup(node) {
  const imageIn = node.imageIn("image");
  const imageOut = node.imageOut("output");
  const fbA = new figment.Framebuffer();
  const fbB = new figment.Framebuffer();
  const program = figment.createShaderProgram(vertexSrc, fragmentSrc);
  // pingPong between framebuffers
  figment.drawQuad(program);
}
`;
    expect(classifyNode(source)).toBe("feedback");
  });

  it('returns "feedback" for iteration loop code', () => {
    const source = `
precision mediump float;
varying vec2 v_uv;
void main() {
  gl_FragColor = vec4(v_uv, 0.0, 1.0);
}

export default function setup(node) {
  const imageIn = node.imageIn("image");
  const imageOut = node.imageOut("output");
  const program = figment.createShaderProgram(vertexSrc, fragmentSrc);
  for (let i = 0; i < iteration; i++) {
    figment.drawQuad(program);
  }
}
`;
    expect(classifyNode(source)).toBe("feedback");
  });

  it('returns "raw" for multi-program code', () => {
    const source = `
precision mediump float;
varying vec2 v_uv;
void main() {
  gl_FragColor = vec4(1.0);
}

export default function setup(node) {
  const imageIn = node.imageIn("image");
  const imageOut = node.imageOut("output");
  const blurH = figment.createShaderProgram(vertexSrc, blurHFrag);
  const blurV = figment.createShaderProgram(vertexSrc, blurVFrag);
  figment.drawQuad(blurH);
  figment.drawQuad(blurV);
}
`;
    expect(classifyNode(source)).toBe("raw");
  });

  it('returns "raw" for multi-input code', () => {
    const source = `
precision mediump float;
varying vec2 v_uv;
void main() {
  gl_FragColor = vec4(1.0);
}

export default function setup(node) {
  const imageA = node.imageIn("imageA");
  const imageB = node.imageIn("imageB");
  const imageOut = node.imageOut("output");
  const program = figment.createShaderProgram(vertexSrc, fragmentSrc);
  figment.drawQuad(program);
}
`;
    expect(classifyNode(source)).toBe("raw");
  });

  it('returns "raw" for unclassifiable code', () => {
    const source = `
export default function setup(node) {
  // does something custom
}
`;
    expect(classifyNode(source)).toBe("raw");
  });
});
