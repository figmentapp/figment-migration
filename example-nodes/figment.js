// Relevant bits in Figment.js

export function generateWgslPreamble({ uniforms = {}, textures = [] }) {
  // Normalize types
  const normalized = {};
  for (const [name, type] of Object.entries(uniforms)) {
    normalized[name] = _canonicalWgslType(type);
  }

  const layout = computeUniformLayout(normalized);
  let structBody = '';
  let padIndex = 0;
  let cursor = 0;

  if (layout.fields.length === 0) {
    structBody = '  _pad0: f32,';
  } else {
    for (const field of layout.fields) {
      // Emit padding for gaps
      while (cursor < field.offset) {
        structBody += `  _pad${padIndex}: f32,\n`;
        padIndex++;
        cursor += 4;
      }
      structBody += `  ${field.name}: ${field.type},\n`;
      cursor = field.offset + field.info.size;
    }
    // Trailing padding to reach totalSize
    while (cursor < layout.totalSize) {
      structBody += `  _pad${padIndex}: f32,\n`;
      padIndex++;
      cursor += 4;
    }
  }

  let wgsl = `struct Uniforms {\n${structBody}};\n`;
  wgsl += `@group(0) @binding(0) var<uniform> u: Uniforms;\n`;
  wgsl += `@group(0) @binding(1) var defaultSampler: sampler;\n`;
  for (let i = 0; i < textures.length; i++) {
    wgsl += `@group(0) @binding(${2 + i}) var ${textures[i]}: texture_2d<f32>;\n`;
  }
  return wgsl;
}

export function createImageGenerator(node, opts) {
  const {
    label,
    wgsl,
    uniforms = {},
    getUniforms,
    getSize,
    output = 'out',
    sampler,
  } = opts;

  const outputPort = node.imageOut(output);

  const result = { pipeline: null, target: null, outputPort };

  node.onStart = () => {
    const normalized = {};
    for (const [n, t] of Object.entries(uniforms)) normalized[n] = _canonicalWgslType(t);
    const preamble = generateWgslPreamble({ uniforms: normalized, textures: [] });
    const fullWgsl = _buildFragmentWgsl(preamble, wgsl);
    result.pipeline = createRenderPipeline({ wgsl: fullWgsl, uniforms: normalized, textures: [], label, sampler });
    result.target = new RenderTarget({ label });
  };

  node.onRender = () => {
    const size = getSize();
    result.target.setSize(size.width, size.height);
    drawFullscreen(result.pipeline, getUniforms ? getUniforms() : {}, {}, result.target);
    outputPort.set(result.target);
  };

  node.onStop = () => {
    result.target?.destroy();
  };

  return result;
}

export function createImageFilter(node, opts) {
  const {
    label,
    wgsl,
    uniforms = {},
    getUniforms,
    input = 'in',
    output = 'out',
    sampler,
  } = opts;

  const inputPort = node.imageIn(input);
  const outputPort = node.imageOut(output);
  const textureNames = ['u_input_texture'];

  const result = { pipeline: null, target: null, inputPort, outputPort };

  node.onStart = () => {
    const normalized = {};
    for (const [n, t] of Object.entries(uniforms)) normalized[n] = _canonicalWgslType(t);
    const preamble = generateWgslPreamble({ uniforms: normalized, textures: textureNames });
    const fullWgsl = _buildFragmentWgsl(preamble, wgsl);
    result.pipeline = createRenderPipeline({ wgsl: fullWgsl, uniforms: normalized, textures: textureNames, label, sampler });
    result.target = new RenderTarget({ label });
  };

  node.onRender = () => {
    const img = inputPort.value;
    if (!img) return;
    result.target.setSize(img.width, img.height);
    drawFullscreen(result.pipeline, getUniforms ? getUniforms() : {}, { u_input_texture: img }, result.target);
    outputPort.set(result.target);
  };

  node.onStop = () => {
    result.target?.destroy();
  };

  return result;
}

export function createFeedbackFilter(node, opts) {
  const {
    label,
    wgsl,
    uniforms = {},
    textures = [],
    getUniforms,
    iterations = 1,
    input = 'in',
    output = 'out',
    sampler,
  } = opts;

  const inputPort = node.imageIn(input);
  const outputPort = node.imageOut(output);
  // Texture order: u_feedback_texture, u_input_texture, ...extra
  const allTextures = ['u_feedback_texture', 'u_input_texture', ...textures];

  const result = { pipeline: null, pp: null, inputPort, outputPort };

  node.onStart = () => {
    const normalized = {};
    for (const [n, t] of Object.entries(uniforms)) normalized[n] = _canonicalWgslType(t);
    const preamble = generateWgslPreamble({ uniforms: normalized, textures: allTextures });
    const fullWgsl = _buildFragmentWgsl(preamble, wgsl);
    result.pipeline = createRenderPipeline({ wgsl: fullWgsl, uniforms: normalized, textures: allTextures, label, sampler });
    result.pp = new PingPongTarget({ label });
  };

  node.onRender = () => {
    const img = inputPort.value;
    if (!img) return;
    result.pp.setSize(img.width, img.height);

    const uniformValues = getUniforms ? getUniforms() : {};
    const iterCount = typeof iterations === 'function' ? iterations() : iterations;

    for (let i = 0; i < iterCount; i++) {
      const texValues = { u_feedback_texture: result.pp.read, u_input_texture: img };
      for (const t of textures) texValues[t] = texValues[t]; // extra textures filled by getUniforms if needed
      drawFullscreen(result.pipeline, uniformValues, texValues, result.pp.write);
      result.pp.swap();
    }

    outputPort.set(result.pp.read);
  };

  node.onStop = () => {
    result.pp?.destroy();
  };

  return result;
}
