# Figment Migration Service — Specification

## Overview

A Cloudflare Workers micro-service that converts Figment project files (`.fgmt`) and individual node source code from the old WebGL format to the new WebGPU format. The conversion is powered by Claude Sonnet 4.6 via the Anthropic SDK.

Figment is a visual node-based creative coding environment. In March 2026, Figment migrated its rendering backend from WebGL to WebGPU. Users with custom shader nodes need their code converted. This service automates that conversion.

---

## Architecture

```
                    +------------------+
                    |   Web Frontend   |
                    |  (vanilla HTML)  |
                    +--------+---------+
                             |
                    POST /api/migrate-to-webgpu
                             |
                    +--------v---------+
                    | Hono API Router  |
                    | (CF Worker)      |
                    +--------+---------+
                             |
              +--------------+--------------+
              |                             |
     Store input in R2           Enqueue task to
     Create D1 task row          Cloudflare Queue
              |                             |
              |              +--------------v---------+
              |              | Queue Consumer Worker  |
              |              | (processes nodes with  |
              |              |  Anthropic SDK)        |
              |              +--------------+---------+
              |                             |
              |              Store output in R2
              |              Update D1 task row
              |                             |
              +--------------+--------------+
                             |
                    GET /api/migrate-to-webgpu/status?id=...
                    GET /api/migrate-to-webgpu/result?id=...
```

### Stack

- **Runtime**: Cloudflare Workers
- **Framework**: Hono (TypeScript)
- **Database**: Cloudflare D1 (task tracking, metadata)
- **Storage**: Cloudflare R2 (input/output files)
- **Queue**: Cloudflare Queues (async processing)
- **AI**: Anthropic SDK with Claude Sonnet 4.6 (`claude-sonnet-4-6`)
- **Cleanup**: Cloudflare Cron Trigger (24-hour file retention)

---

## File Format

### `.fgmt` Structure

A `.fgmt` file is a JSON document:

```json
{
  "version": 5,
  "nodes": [
    { "id": 1, "name": "Load Movie", "type": "image.loadMovie", "x": 100, "y": 50, "values": { ... } },
    { "id": 4, "name": "Custom Threshold", "type": "project.customThreshold", "x": 250, "y": 350, "values": { ... } }
  ],
  "connections": [
    { "outNode": 1, "outPort": "out", "inNode": 2, "inPort": "in" }
  ],
  "settings": { "oscEnabled": false, "oscPort": 8000 },
  "types": [
    {
      "name": "Custom Threshold",
      "type": "project.customThreshold",
      "source": "/* JavaScript source code for the custom node */",
      "description": ""
    }
  ]
}
```

**Key points:**
- `nodes` and `connections` define the graph topology — these are NOT modified during migration (except node references to types that change)
- `types` contains custom node definitions with their `source` code — this is what gets converted
- Built-in nodes (e.g. `image.sobel`, `image.resize`, `core.out`) have NO entry in `types` and are left completely untouched
- Old files have `"version": 5`, migrated files get `"version": 6`

### What Gets Converted

Only entries in the `types` array that contain a `source` field with WebGL code. Detection: the source contains any of these WebGL markers:
- `gl_FragColor`
- `texture2D(`
- `varying vec2 v_uv`
- `precision mediump float`
- `figment.createShaderProgram(`
- `new figment.Framebuffer(`
- `framebuffer.bind()`
- `figment.drawQuad(`
- `figment.clear()`

If a type's source contains none of these markers, it is already WebGPU or non-shader code — skip it.

---

## Node Classification Heuristic

Before sending code to the AI, a deterministic heuristic classifies each node into one of four categories. This classification is included in the prompt to guide the AI.

### 1. Image Generator

**Detection:**
- Has NO `node.imageIn(` call
- Has `node.imageOut(` call
- Has explicit width/height parameters (e.g. `node.numberIn('width', ...)`)
- Has `new figment.Framebuffer(w, h)` (with initial size arguments)

**WebGPU target:** `figment.createImageGenerator(node, { ... })`

### 2. Image Filter

**Detection:**
- Has exactly ONE `node.imageIn(` call
- Has exactly ONE `node.imageOut(` call
- Has ONE `figment.createShaderProgram(` call
- Has ONE `new figment.Framebuffer()` (no initial size — takes size from input)
- Has NO ping-pong / feedback patterns

**WebGPU target:** `figment.createImageFilter(node, { ... })`

### 3. Feedback Filter

**Detection:**
- Has `node.imageIn(` call
- Has ping-pong pattern: multiple `Framebuffer` instances, OR iteration loops over framebuffers, OR `u_prev_texture` uniform
- May have `node.triggerButtonIn('reset')` or `node.triggerButtonIn('clear')`

**WebGPU target:** `figment.createFeedbackFilter(node, { ... })`

### 4. Raw WGSL (fallback)

**Detection:** Anything that doesn't cleanly fit the above:
- Multiple pipelines / shader programs
- Dynamic shader recompilation (e.g. `composite.js` rebuilds shader on blend mode change)
- Output size differs from input size in non-trivial ways
- Multiple image inputs with complex compositing
- Two or more `figment.createShaderProgram(` calls

**WebGPU target:** Uses `figment.generateWgslPreamble()` + raw `figment.createRenderPipeline()` API

### Classification Algorithm (pseudocode)

```
function classify(source):
  imageInCount  = count occurrences of node.imageIn(
  imageOutCount = count occurrences of node.imageOut(
  programCount  = count occurrences of figment.createShaderProgram(
  fbCount       = count occurrences of new figment.Framebuffer
  hasPingPong   = source matches /pingPong|u_prev_texture|Framebuffer\(\).*Framebuffer\(\)/
  hasIterLoop   = source matches /for\s*\(.*iterations/
  hasWidthHeight = source matches /node\.numberIn\(['"]width/ AND /node\.numberIn\(['"]height/

  if programCount > 1:           return "raw"
  if imageInCount > 1:           return "raw"
  if imageInCount == 0 AND hasWidthHeight:  return "generator"
  if hasPingPong OR hasIterLoop: return "feedback"
  if imageInCount == 1 AND imageOutCount == 1: return "filter"
  return "raw"
```

---

## AI Conversion Prompt

A single universal prompt handles all node types. The prompt includes:
1. Complete conversion rules for GLSL -> WGSL
2. Complete conversion rules for WebGL API -> WebGPU API
3. Few-shot examples for each node type
4. The heuristic classification result as a hint

### System Prompt

```
You are a code migration assistant that converts Figment creative coding nodes from WebGL to WebGPU. You perform mechanical, faithful conversions — the visual/functional output of the node MUST remain identical.

## Rules

### GLSL to WGSL Shader Translation

| GLSL (old)                          | WGSL (new)                                      |
|-------------------------------------|--------------------------------------------------|
| `precision mediump float;`          | Remove entirely                                  |
| `varying vec2 v_uv;`               | Remove (use `in.uv` from VertexOutput)           |
| `uniform sampler2D name;`          | Remove (declared by preamble/helper)             |
| `uniform float name;`              | Remove (declared in uniforms object)             |
| `uniform vec2 name;`               | Remove (declared in uniforms object)             |
| `uniform vec3 name;`               | Remove (declared in uniforms object)             |
| `uniform vec4 name;`               | Remove (declared in uniforms object)             |
| `void main() { ... }`             | Fragment body or `@fragment fn fs_main(in: VertexOutput) -> @location(0) vec4f { ... }` |
| `gl_FragColor = expr;`            | `return expr;`                                   |
| `texture2D(sampler, uv)`          | `textureSample(texture_name, defaultSampler, uv)` |
| `vec2(x, y)`                      | `vec2f(x, y)`                                   |
| `vec3(x, y, z)`                   | `vec3f(x, y, z)`                                |
| `vec4(x, y, z, w)`                | `vec4f(x, y, z, w)`                             |
| `float`                            | `f32`                                            |
| `int`                              | `i32`                                            |
| `bool`                             | `bool`                                           |
| `mat4`                             | `mat4x4f`                                        |
| `v_uv`                             | `in.uv`                                         |
| `name` (uniform access)           | `u.name` (accessed via uniform struct)           |
| `mix(a, b, t)`                    | `mix(a, b, t)` (same)                           |
| `step(edge, x)`                   | `step(edge, x)` (same)                          |
| `mod(x, y)`                       | `x % y` or `fract(x)` for mod(x, 1.0)          |
| `atan(y, x)`                      | `atan2(y, x)`                                   |
| `float x = expr;`                 | `var x = expr;` or `let x = expr;`              |
| `vec3 x = expr;`                  | `var x = expr;` or `let x = expr;`              |

Use `let` for immutable bindings, `var` when the variable is reassigned later.

### GLSL to WGSL Type Mapping for Uniforms

| GLSL uniform type | WGSL type in uniforms object |
|--------------------|-------------------------------|
| `float`            | `'f32'`                       |
| `vec2`             | `'vec2f'`                     |
| `vec3`             | `'vec3f'`                     |
| `vec4`             | `'vec4f'`                     |
| `mat4`             | `'mat4x4f'`                   |

### WebGL API to WebGPU API Translation

| WebGL (old)                                         | WebGPU (new)                                     |
|-----------------------------------------------------|--------------------------------------------------|
| `figment.createShaderProgram(fragmentShader)`       | Removed — handled by helper                      |
| `new figment.Framebuffer()`                          | Removed — handled by helper                      |
| `new figment.Framebuffer(w, h)`                      | Removed — handled by helper                      |
| `framebuffer.setSize(w, h)`                          | Removed — handled by helper                      |
| `framebuffer.bind()` / `framebuffer.unbind()`       | Removed — handled by helper                      |
| `figment.clear()`                                    | Removed — handled by helper                      |
| `figment.drawQuad(program, uniforms)`                | Removed — handled by helper                      |
| `imageOut.set(framebuffer)`                          | Removed — handled by helper                      |
| `node.onStart = () => { ... }`                       | Removed — handled by helper                      |
| `node.onRender = () => { ... }`                      | Removed — handled by helper                      |
| `node.onStop = () => { ... }`                        | Removed — handled by helper                      |
| `imageIn.value.texture` (passed to drawQuad)         | Removed — helper binds `u_input_texture` automatically |
| `[colorIn.value[0]/255, colorIn.value[1]/255, ...]` | `figment.colorToVec3(colorIn.value)` or `figment.colorToVec4(colorIn.value)` |

### Texture Name Mapping

| Old name           | New name              |
|--------------------|-----------------------|
| `u_input_texture`  | `u_input_texture` (same) |
| `u_prev_texture`   | `u_feedback_texture`  |
| Any custom sampler2D used for the main input | `u_input_texture` |
| Any custom sampler2D used for feedback/previous frame | `u_feedback_texture` |

### Critical Constraints

1. **Functional equivalence**: The converted node MUST produce the same visual output as the original. Do not change the algorithm, math, or logic.
2. **Preserve JSDoc comments**: Keep the `@name`, `@description`, and `@category` annotations exactly as they are.
3. **Preserve parameter definitions**: Keep all `node.numberIn()`, `node.colorIn()`, `node.selectIn()`, `node.triggerButtonIn()` etc. with the same names, defaults, and ranges.
4. **Use helpers when possible**: If the node is classified as generator/filter/feedback, use `figment.createImageGenerator`, `figment.createImageFilter`, or `figment.createFeedbackFilter` respectively. Only use raw API for nodes classified as "raw".
5. **Remove all boilerplate**: The WebGPU helpers handle pipeline creation, render targets, size management, null-input guards, and cleanup. Remove ALL of: `let program, framebuffer`, `node.onStart`, `node.onRender`, `node.onStop`, `framebuffer.bind/unbind`, `figment.clear()`, `figment.drawQuad()`.
6. **WGSL fragment body vs full function**: If the shader has helper functions (anything defined before `void main()`), use the full `@fragment fn fs_main(in: VertexOutput) -> @location(0) vec4f { ... }` form with the helpers placed before it. If the shader is just a simple main body, use the fragment body form (no `@fragment` keyword — the helper will wrap it).
7. **Uniform access**: All uniforms are accessed via `u.uniform_name` in WGSL (through the Uniforms struct).
8. **Output only the converted source code.** No explanations, no markdown fences, no commentary.

## Node Type Helpers

### createImageFilter — for single-input, single-output filter nodes

```js
figment.createImageFilter(node, {
  label: 'nodeName',           // short identifier
  uniforms: { u_name: 'f32' }, // uniform declarations (WGSL types)
  wgsl: `...`,                 // WGSL fragment body or full @fragment fn
  getUniforms: () => ({        // called each frame to provide uniform values
    u_name: someInput.value,
  }),
});
```

The helper automatically:
- Creates `node.imageIn('in')` and `node.imageOut('out')`
- Handles pipeline creation, render target, size management, null-input guards, cleanup
- Binds `u_input_texture` automatically (available in WGSL)
- Provides `in.uv` for texture coordinates
- Provides `defaultSampler` for texture sampling

### createImageGenerator — for nodes that produce output without image input

```js
figment.createImageGenerator(node, {
  label: 'nodeName',
  uniforms: { u_color: 'vec4f' },
  wgsl: `return u.u_color;`,
  getUniforms: () => ({ u_color: figment.colorToVec4(colorIn.value) }),
  getSize: () => ({ width: widthIn.value, height: heightIn.value }),
});
```

The helper automatically:
- Creates `node.imageOut('out')`
- Handles pipeline creation, render target, cleanup
- Calls `getSize()` each frame to set output dimensions

### createFeedbackFilter — for temporal feedback / ping-pong nodes

```js
const result = figment.createFeedbackFilter(node, {
  label: 'nodeName',
  uniforms: { u_fade: 'f32' },
  wgsl: `...`,
  getUniforms: () => ({ u_fade: fadeIn.value }),
  iterations: () => iterationsIn.value,  // optional, default 1
});
```

The helper automatically:
- Creates `node.imageIn('in')` and `node.imageOut('out')`
- Manages a `PingPongTarget` (double-buffered render targets)
- Binds `u_feedback_texture` (previous frame) and `u_input_texture` (current input)
- Supports multiple iterations per frame
- Returns `{ pp, ... }` for manual reset:

```js
resetIn.onTrigger = () => {
  result.pp.destroy();
  result.pp = new figment.PingPongTarget();
};
```

### Raw WGSL — for complex nodes

Complex nodes use `figment.generateWgslPreamble()` directly:

```js
const preamble = figment.generateWgslPreamble({
  uniforms: { u_threshold: 'f32', u_color: 'vec3f' },
  textures: ['u_input_texture'],
});
```

Then manually call `figment.createRenderPipeline()`, `figment.drawFullscreen()`, etc. Convert the shader to WGSL but keep the lifecycle management manual.

## Few-Shot Examples

### Example 1: Image Filter (Chroma Key)

INPUT (WebGL):
```js
/**
 * @name Chroma Key
 * @description Make pixels of a certain color transparent, like green screen effect.
 * @category image
 */

const fragmentShader = `
precision mediump float;
uniform sampler2D u_input_texture;
uniform vec3 u_keyColor;
uniform float u_threshold;
varying vec2 v_uv;
void main() {
  vec2 uv = v_uv;
  vec4 color = texture2D(u_input_texture, uv.st);
  float difference = length(color.rgb - u_keyColor);
  if (difference < u_threshold) {
    color.a = 0.0;
  }
  gl_FragColor = color;
}
`;

const imageIn = node.imageIn('in');
const colorIn = node.colorIn('key color', [0, 255, 0]);
const thresholdIn = node.numberIn('threshold', 0.4, { min: 0.0, max: 1.0, step: 0.01 });
const imageOut = node.imageOut('out');

let program, framebuffer;

node.onStart = (props) => {
  program = figment.createShaderProgram(fragmentShader);
  framebuffer = new figment.Framebuffer();
};

node.onRender = () => {
  if (!imageIn.value) return;
  framebuffer.setSize(imageIn.value.width, imageIn.value.height);
  framebuffer.bind();
  figment.clear();
  figment.drawQuad(program, {
    u_input_texture: imageIn.value.texture,
    u_keyColor: [colorIn.value[0] / 255, colorIn.value[1] / 255, colorIn.value[2] / 255],
    u_threshold: thresholdIn.value,
  });
  framebuffer.unbind();
  imageOut.set(framebuffer);
};
```

CLASSIFICATION HINT: filter

OUTPUT (WebGPU):
```js
/**
 * @name Chroma Key
 * @description Make pixels of a certain color transparent, like green screen effect.
 * @category image
 */

const colorIn = node.colorIn('key color', [0, 255, 0]);
const thresholdIn = node.numberIn('threshold', 0.4, { min: 0.0, max: 1.0, step: 0.01 });

figment.createImageFilter(node, {
  label: 'chromaKey',
  uniforms: { u_keyColor: 'vec3f', u_threshold: 'f32' },
  wgsl: `
    var color = textureSample(u_input_texture, defaultSampler, in.uv);
    let difference = length(color.rgb - u.u_keyColor);
    if (difference < u.u_threshold) {
      color.a = 0.0;
    }
    return color;
  `,
  getUniforms: () => ({
    u_keyColor: figment.colorToVec3(colorIn.value),
    u_threshold: thresholdIn.value,
  }),
});
```

### Example 2: Image Generator (Constant Color)

INPUT (WebGL):
```js
/**
 * @name Constant
 * @description Render a constant color.
 * @category image
 */

const fragmentShader = `
precision mediump float;
uniform vec4 u_color;
varying vec2 v_uv;
void main() {
  gl_FragColor = u_color;
}
`;

const colorIn = node.colorIn('color', [128, 128, 128, 1.0]);
const widthIn = node.numberIn('width', 1024, { min: 1, max: 4096, step: 1 });
const heightIn = node.numberIn('height', 512, { min: 1, max: 4096, step: 1 });
const imageOut = node.imageOut('out');

let program, framebuffer;

node.onStart = () => {
  program = figment.createShaderProgram(fragmentShader);
  framebuffer = new figment.Framebuffer(widthIn.value, heightIn.value);
};

node.onRender = () => {
  framebuffer.setSize(widthIn.value, heightIn.value);
  framebuffer.bind();
  figment.clear();
  figment.drawQuad(program, {
    u_color: [colorIn.value[0] / 255, colorIn.value[1] / 255, colorIn.value[2] / 255, colorIn.value[3]],
  });
  framebuffer.unbind();
  imageOut.set(framebuffer);
};
```

CLASSIFICATION HINT: generator

OUTPUT (WebGPU):
```js
/**
 * @name Constant
 * @description Render a constant color.
 * @category image
 */

const colorIn = node.colorIn('color', [128, 128, 128, 1.0]);
const widthIn = node.numberIn('width', 1024, { min: 1, max: 4096, step: 1 });
const heightIn = node.numberIn('height', 512, { min: 1, max: 4096, step: 1 });

figment.createImageGenerator(node, {
  label: 'constant',
  uniforms: { u_color: 'vec4f' },
  wgsl: `return u.u_color;`,
  getUniforms: () => ({ u_color: figment.colorToVec4(colorIn.value) }),
  getSize: () => ({ width: widthIn.value, height: heightIn.value }),
});
```

### Example 3: Feedback Filter (Reaction Diffusion)

INPUT (WebGL):
```js
/**
 * @name Reaction Diffusion
 * @description Reaction diffusion on input image.
 * @category image
 */

const fragmentShader = `
precision mediump float;
uniform sampler2D u_input_texture;
uniform sampler2D u_prev_texture;
uniform vec2 u_resolution;
varying vec2 v_uv;
uniform float u_influence;
uniform float u_delta_time;
uniform float u_feed_rate;
uniform float u_kill_rate;
uniform float u_diffusion_rate_a;
uniform float u_diffusion_rate_b;

void main() {
  vec2 uv = v_uv;
  vec2 texel_size = 1.0 / u_resolution;

  vec4 current = texture2D(u_input_texture, uv);
  vec4 laplacian = texture2D(u_input_texture, uv + vec2(-1.0, 0.0) * texel_size) +
                   texture2D(u_input_texture, uv + vec2(1.0, 0.0) * texel_size) +
                   texture2D(u_input_texture, uv + vec2(0.0, -1.0) * texel_size) +
                   texture2D(u_input_texture, uv + vec2(0.0, 1.0) * texel_size) -
                   4.0 * current;

  vec4 pixel = current + texture2D(u_prev_texture, uv) * u_influence;
  float a = pixel.r;
  float b = pixel.g;

  float reaction = a * b * b;
  float da = u_diffusion_rate_a * laplacian.r - reaction + u_feed_rate * (1.0 - a);
  float db = u_diffusion_rate_b * laplacian.g + reaction - (u_kill_rate + u_feed_rate) * b;

  vec2 result = current.rg + vec2(da, db) * u_delta_time;
  gl_FragColor = vec4(result.r, result.g, 0.0, 1.0);
}
`;

const imageIn = node.imageIn('in');
const influenceIn = node.numberIn('influence', 0.15, { min: 0.0, max: 1.0, step: 0.01 });
const deltaTimeIn = node.numberIn('delta time', 1.0);
const feedRateIn = node.numberIn('feed rate', 0.037, { min: 0.0, max: 0.1, step: 0.0001 });
const killRateIn = node.numberIn('kill rate', 0.06, { min: 0.0, max: 0.1, step: 0.0001 });
const diffusionRateAIn = node.numberIn('diffusion A', 0.2097, { min: 0.0, max: 1.0, step: 0.0001 });
const diffusionRateBIn = node.numberIn('diffusion B', 0.105, { min: 0.0, max: 1.0, step: 0.0001 });
const iterationsIn = node.numberIn('iterations', 10, { min: 1, max: 50, step: 1 });
const resetIn = node.triggerButtonIn('reset');
const imageOut = node.imageOut('out');

let program, copyProgram, framebuffer, pingPongFramebuffers;

node.onStart = (props) => {
  program = figment.createShaderProgram(fragmentShader);
  framebuffer = new figment.Framebuffer();
  pingPongFramebuffers = [new figment.Framebuffer(), new figment.Framebuffer()];
};

node.onRender = () => {
  if (!imageIn.value) return;

  const width = imageIn.value.width;
  const height = imageIn.value.height;

  framebuffer.setSize(width, height);
  pingPongFramebuffers[0].setSize(width, height);
  pingPongFramebuffers[1].setSize(width, height);

  for (let i = 0; i < iterationsIn.value; i++) {
    pingPongFramebuffers[1].bind();
    figment.clear();
    figment.drawQuad(program, {
      u_input_texture: pingPongFramebuffers[0].texture,
      u_prev_texture: imageIn.value.texture,
      u_resolution: [width, height],
      u_influence: influenceIn.value,
      u_delta_time: deltaTimeIn.value,
      u_feed_rate: feedRateIn.value,
      u_kill_rate: killRateIn.value,
      u_diffusion_rate_a: diffusionRateAIn.value,
      u_diffusion_rate_b: diffusionRateBIn.value,
    });
    pingPongFramebuffers[1].unbind();

    const temp = pingPongFramebuffers[0];
    pingPongFramebuffers[0] = pingPongFramebuffers[1];
    pingPongFramebuffers[1] = temp;
  }

  framebuffer.bind();
  figment.clear();
  figment.drawQuad(program, { u_input_texture: pingPongFramebuffers[0].texture });
  framebuffer.unbind();

  imageOut.set(framebuffer);
};

function resetSimulation() {
  pingPongFramebuffers[0].bind();
  figment.clear();
  pingPongFramebuffers[0].unbind();
}
node.onReset = resetSimulation;
resetIn.onTrigger = resetSimulation;
```

CLASSIFICATION HINT: feedback

OUTPUT (WebGPU):
```js
/**
 * @name Reaction Diffusion
 * @description Reaction diffusion on input image.
 * @category image
 */

const influenceIn = node.numberIn('influence', 0.15, { min: 0.0, max: 1.0, step: 0.01 });
const deltaTimeIn = node.numberIn('delta time', 1.0);
const feedRateIn = node.numberIn('feed rate', 0.037, { min: 0.0, max: 0.1, step: 0.0001 });
const killRateIn = node.numberIn('kill rate', 0.06, { min: 0.0, max: 0.1, step: 0.0001 });
const diffusionRateAIn = node.numberIn('diffusion A', 0.2097, { min: 0.0, max: 1.0, step: 0.0001 });
const diffusionRateBIn = node.numberIn('diffusion B', 0.105, { min: 0.0, max: 1.0, step: 0.0001 });
const iterationsIn = node.numberIn('iterations', 10, { min: 1, max: 50, step: 1 });
const resetIn = node.triggerButtonIn('reset');

const result = figment.createFeedbackFilter(node, {
  label: 'reactionDiffusion',
  uniforms: {
    u_resolution: 'vec2f',
    u_influence: 'f32',
    u_delta_time: 'f32',
    u_feed_rate: 'f32',
    u_kill_rate: 'f32',
    u_diffusion_rate_a: 'f32',
    u_diffusion_rate_b: 'f32',
  },
  wgsl: `
    @fragment
    fn fs_main(in: VertexOutput) -> @location(0) vec4f {
      let uv = in.uv;
      let texel_size = 1.0 / u.u_resolution;

      let current = textureSample(u_feedback_texture, defaultSampler, uv);
      let laplacian = textureSample(u_feedback_texture, defaultSampler, uv + vec2f(-1.0, 0.0) * texel_size) +
                      textureSample(u_feedback_texture, defaultSampler, uv + vec2f(1.0, 0.0) * texel_size) +
                      textureSample(u_feedback_texture, defaultSampler, uv + vec2f(0.0, -1.0) * texel_size) +
                      textureSample(u_feedback_texture, defaultSampler, uv + vec2f(0.0, 1.0) * texel_size) -
                      4.0 * current;

      let pixel = current + textureSample(u_input_texture, defaultSampler, uv) * u.u_influence;
      let a = pixel.r;
      let b = pixel.g;

      let reaction = a * b * b;
      let da = u.u_diffusion_rate_a * laplacian.r - reaction + u.u_feed_rate * (1.0 - a);
      let db = u.u_diffusion_rate_b * laplacian.g + reaction - (u.u_kill_rate + u.u_feed_rate) * b;

      let rd_result = current.rg + vec2f(da, db) * u.u_delta_time;
      return vec4f(rd_result.r, rd_result.g, 0.0, 1.0);
    }
  `,
  getUniforms: () => ({
    u_resolution: [result.pp.width, result.pp.height],
    u_influence: influenceIn.value,
    u_delta_time: deltaTimeIn.value,
    u_feed_rate: feedRateIn.value,
    u_kill_rate: killRateIn.value,
    u_diffusion_rate_a: diffusionRateAIn.value,
    u_diffusion_rate_b: diffusionRateBIn.value,
  }),
  iterations: () => iterationsIn.value,
});

function resetSimulation() {
  result.pp.destroy();
  result.pp = new figment.PingPongTarget();
}
node.onReset = resetSimulation;
resetIn.onTrigger = resetSimulation;
```

### Example 4: Simple Filter (Threshold — from .fgmt file)

INPUT (WebGL):
```js
/**
 * @name Threshold
 * @description Change brightness threshold of input image.
 * @category image
 */

const fragmentShader = `
precision mediump float;
uniform sampler2D u_input_texture;
uniform float u_threshold;
varying vec2 v_uv;

void main() {
  vec2 uv = v_uv;
  vec3 col = texture2D(u_input_texture, uv.st).rgb;
  float brightness = 0.33333 * (col.r + col.g + col.b);
  float b = mix(0.0, 1.0, step(u_threshold, brightness));
  gl_FragColor = vec4(b, b, b, 1.0);
}
`;

const imageIn = node.imageIn('in');
const thresholdIn = node.numberIn('threshold', 0.5, { min: 0, max: 1, step: 0.01 });
const imageOut = node.imageOut('out');

let program, framebuffer;

node.onStart = (props) => {
  program = figment.createShaderProgram(fragmentShader);
  framebuffer = new figment.Framebuffer();
};

node.onRender = () => {
  if (!imageIn.value) return;
  framebuffer.setSize(imageIn.value.width, imageIn.value.height);
  framebuffer.bind();
  figment.clear();
  figment.drawQuad(program, {
    u_input_texture: imageIn.value.texture,
    u_threshold: thresholdIn.value,
  });
  framebuffer.unbind();
  imageOut.set(framebuffer);
};
```

CLASSIFICATION HINT: filter

OUTPUT (WebGPU):
```js
/**
 * @name Threshold
 * @description Change brightness threshold of input image.
 * @category image
 */

const thresholdIn = node.numberIn('threshold', 0.5, { min: 0, max: 1, step: 0.01 });

figment.createImageFilter(node, {
  label: 'threshold',
  uniforms: { u_threshold: 'f32' },
  wgsl: `
    let col = textureSample(u_input_texture, defaultSampler, in.uv).rgb;
    let brightness = 0.33333 * (col.r + col.g + col.b);
    let b = mix(0.0, 1.0, step(u.u_threshold, brightness));
    return vec4f(b, b, b, 1.0);
  `,
  getUniforms: () => ({ u_threshold: thresholdIn.value }),
});
```

### Important Notes for Feedback Filters

In the old WebGL code, feedback nodes often use confusing texture naming. The pattern is:
- The "ping-pong" texture (previous frame / iterative state) was often sampled from `u_input_texture` in the old code (because `drawQuad` passed `pingPongFramebuffers[0].texture` as `u_input_texture`)
- The "live input" texture (current camera/video frame) was often passed as `u_prev_texture`

In the new WebGPU code, the naming is canonical:
- `u_feedback_texture` = previous frame / iterative state (from PingPongTarget)
- `u_input_texture` = current live input

You MUST carefully trace which texture is which by looking at what's passed in the `drawQuad` call, NOT by the uniform name. Map them correctly to the new canonical names.
```

### User Message Template

```
Convert this Figment node from WebGL to WebGPU.

CLASSIFICATION: {classification}

SOURCE CODE:
{source_code}
```

---

## API Endpoints

### POST `/api/migrate-to-webgpu`

**Request body:** multipart/form-data with either:
- `file`: a `.fgmt` file
- `source`: raw source code string for a single node

**Response:**
```json
{
  "id": "task_abc123",
  "status": "queued",
  "nodeCount": 3,
  "message": "Migration queued. Poll /api/migrate-to-webgpu/status?id=task_abc123 for progress."
}
```

**Behavior:**
1. Parse input (JSON for .fgmt, raw string for source)
2. For .fgmt: identify custom types in `types[]` that need conversion (WebGL markers present)
3. Store input in R2: `inputs/{taskId}.json`
4. Create D1 task row: `{ id, status: 'queued', created_at, node_count, nodes_completed, input_key, output_key }`
5. Enqueue to Cloudflare Queue with `{ taskId }`
6. Return task ID

### GET `/api/migrate-to-webgpu/status?id={taskId}`

**Response:**
```json
{
  "id": "task_abc123",
  "status": "processing",
  "nodeCount": 3,
  "nodesCompleted": 1,
  "errors": []
}
```

**Status values:** `queued` | `processing` | `completed` | `failed` | `partial`

- `partial` = some nodes converted, some failed. The output file contains converted nodes + original code for failed nodes with error annotations.

### GET `/api/migrate-to-webgpu/result?id={taskId}`

**Response:**
- If `.fgmt` input: returns the converted `.fgmt` file as `application/json` download
- If source code input: returns the converted source code as `text/plain`
- If not ready: `{ "error": "Task not completed", "status": "processing" }`

---

## Web Frontend

A single-page vanilla HTML/CSS/JS interface (no build step, served from the Worker).

### Layout

Two tabs: **Project File** | **Source Code**

#### Project File Tab
- Drag-and-drop zone for `.fgmt` files (also click-to-upload)
- On upload: POST to API, show progress bar with node-by-node status (poll `/status`)
- On completion: download button for converted `.fgmt` file
- On partial failure: download button + warning listing which nodes failed

#### Source Code Tab
- Text area for pasting node source code
- "Convert" button
- On completion: show converted source code inline with syntax highlighting (using a lightweight highlighter like Prism or highlight.js served from CDN)
- Copy-to-clipboard button

### Styling
- Dark theme (matches Figment's aesthetic — dark background, light text)
- Minimal, functional design per the mockup
- Font: monospace for code areas

---

## Database Schema (D1)

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'queued',  -- queued, processing, completed, failed, partial
  input_type TEXT NOT NULL,               -- 'fgmt' or 'source'
  node_count INTEGER NOT NULL DEFAULT 0,
  nodes_completed INTEGER NOT NULL DEFAULT 0,
  errors TEXT,                            -- JSON array of error objects
  input_key TEXT NOT NULL,                -- R2 key for input
  output_key TEXT,                        -- R2 key for output (set on completion)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_tasks_created_at ON tasks(created_at);
CREATE INDEX idx_tasks_status ON tasks(status);
```

---

## Storage (R2)

- `inputs/{taskId}.json` — original input (fgmt JSON or `{ "source": "..." }`)
- `outputs/{taskId}.json` — converted output (fgmt JSON or `{ "source": "..." }`)

---

## Queue Consumer

The queue consumer processes one task at a time:

1. Read task from D1, update status to `processing`
2. Read input from R2
3. For each custom type with WebGL code:
   a. Run classification heuristic
   b. Build prompt with classification hint + source
   c. Call Anthropic API (Claude Sonnet 4.6)
   d. Run structural validation on output
   e. Update `nodes_completed` in D1
4. Assemble output:
   - For `.fgmt`: replace each type's `source` with converted code, bump `version` to 6
   - For source: use converted code directly
5. Store output in R2
6. Update D1 status to `completed` (or `partial` if some nodes failed)

### Structural Validation

After AI conversion, check:
- Output contains exactly one of: `figment.createImageFilter(`, `figment.createImageGenerator(`, `figment.createFeedbackFilter(`, or `figment.generateWgslPreamble(`
- If helper used: contains `wgsl:` property with backtick string
- If helper used: contains `label:` property
- Preserves the same JSDoc block as the input
- Does NOT contain any WebGL markers (no `gl_FragColor`, `texture2D`, `figment.createShaderProgram`, etc.)

If validation fails, retry once with an additional instruction appended: "Your previous output had validation errors: {errors}. Please fix these issues."

If retry also fails, mark node as failed and keep original source in output with a comment: `// MIGRATION FAILED: {error}. Original WebGL code preserved.`

---

## Cron Cleanup

A scheduled trigger runs every hour:

```sql
DELETE FROM tasks WHERE created_at < datetime('now', '-24 hours');
```

Also delete corresponding R2 objects (`inputs/{id}.json`, `outputs/{id}.json`) for each deleted task.

---

## Configuration

### Environment Variables / Secrets

| Name                | Description                           |
|---------------------|---------------------------------------|
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude access   |

### Bindings (wrangler.toml)

| Binding        | Type  | Description                    |
|----------------|-------|--------------------------------|
| `DB`           | D1    | Task tracking database         |
| `STORAGE`      | R2    | Input/output file storage      |
| `MIGRATION_QUEUE` | Queue | Async task processing queue |

---

## Error Handling

- **Invalid file format**: 400 with descriptive error
- **No custom nodes found**: Return immediately with `{ "status": "completed", "message": "No custom WebGL nodes found. File is already compatible." }`
- **Anthropic API error**: Retry up to 2 times with exponential backoff. If all retries fail, mark node as failed.
- **Queue processing timeout**: Workers have a 15-minute max for queue consumers. If a file has many nodes, process them sequentially within this limit. If it would exceed, split into multiple queue messages.

---

## Project Structure

```
figment-migration/
  src/
    index.ts              -- Hono app, routes, static file serving
    queue.ts              -- Queue consumer handler
    classifier.ts         -- Node type classification heuristic
    converter.ts          -- Anthropic SDK integration, prompt building
    validator.ts          -- Structural validation of AI output
    types.ts              -- TypeScript type definitions
    frontend/
      index.html          -- Single-page web UI
  demo-projects/          -- Example .fgmt files for testing
  example-nodes/          -- Example node source files (old + new)
  wrangler.toml           -- Cloudflare Workers config
  package.json
  tsconfig.json
  SPEC.md                 -- This file
```
