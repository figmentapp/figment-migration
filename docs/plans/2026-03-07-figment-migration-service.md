# Figment WebGL→WebGPU Migration Service — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Cloudflare Workers service that converts Figment `.fgmt` project files and individual node source code from WebGL to WebGPU using AI-powered shader translation.

**Architecture:** Hono API receives uploads, stores in R2, enqueues to Cloudflare Queue. A queue consumer classifies each node (generator/filter/feedback/raw), calls Claude Sonnet 4.6 via the Anthropic SDK for GLSL→WGSL conversion, validates output structurally, and stores results. A vanilla HTML frontend provides drag-and-drop upload and inline code display.

**Tech Stack:** Cloudflare Workers, Hono 4.x, D1, R2, Cloudflare Queues, Anthropic SDK (`@anthropic-ai/sdk`), TypeScript, Vitest

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `wrangler.toml`
- Create: `src/index.ts`
- Create: `src/types.ts`
- Create: `schema.sql`

**Step 1: Initialize package.json**

```bash
cd /Users/fdb/Projects/figment-migration
npm init -y
```

Then replace `package.json` with:

```json
{
  "name": "figment-migration",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:migrate:local": "wrangler d1 execute figment-migration-db --local --file=schema.sql",
    "db:migrate:remote": "wrangler d1 execute figment-migration-db --remote --file=schema.sql"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "hono": "^4.7.0"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20250224.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0",
    "wrangler": "^4.0.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2021",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "lib": ["ES2021"],
    "types": ["@cloudflare/workers-types"],
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules"]
}
```

**Step 3: Create wrangler.toml**

```toml
name = "figment-migration"
main = "src/index.ts"
compatibility_date = "2025-03-01"

[triggers]
crons = ["0 * * * *"]

[[d1_databases]]
binding = "DB"
database_name = "figment-migration-db"
database_id = "placeholder-will-be-set-after-creation"

[[r2_buckets]]
binding = "STORAGE"
bucket_name = "figment-migration-storage"

[[queues.producers]]
binding = "MIGRATION_QUEUE"
queue = "figment-migration-queue"

[[queues.consumers]]
queue = "figment-migration-queue"
max_batch_size = 1
max_retries = 2
```

**Step 4: Create schema.sql**

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'queued',
  input_type TEXT NOT NULL,
  node_count INTEGER NOT NULL DEFAULT 0,
  nodes_completed INTEGER NOT NULL DEFAULT 0,
  errors TEXT,
  input_key TEXT NOT NULL,
  output_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
```

**Step 5: Create src/types.ts**

```ts
export interface Env {
  DB: D1Database;
  STORAGE: R2Bucket;
  MIGRATION_QUEUE: Queue;
  ANTHROPIC_API_KEY: string;
}

export interface Task {
  id: string;
  status: "queued" | "processing" | "completed" | "failed" | "partial";
  input_type: "fgmt" | "source";
  node_count: number;
  nodes_completed: number;
  errors: string | null;
  input_key: string;
  output_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface FgmtFile {
  version: number;
  nodes: FgmtNode[];
  connections: FgmtConnection[];
  settings: Record<string, unknown>;
  types: FgmtType[];
}

export interface FgmtNode {
  id: number;
  name: string;
  type: string;
  x: number;
  y: number;
  values?: Record<string, unknown>;
}

export interface FgmtConnection {
  outNode: number;
  outPort: string;
  inNode: number;
  inPort: string;
}

export interface FgmtType {
  name: string;
  type: string;
  source: string;
  description: string;
}

export type NodeClassification = "generator" | "filter" | "feedback" | "raw";

export interface ConversionResult {
  typeName: string;
  success: boolean;
  convertedSource?: string;
  error?: string;
}

export interface QueueMessage {
  taskId: string;
}
```

**Step 6: Create minimal src/index.ts**

```ts
import { Hono } from "hono";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.text("Figment Migration Service"));

export default {
  fetch: app.fetch,
};
```

**Step 7: Install dependencies and verify**

```bash
npm install
npm run typecheck
```

Expected: no errors.

**Step 8: Commit**

```bash
git add -A
git commit -m "feat: scaffold project with Hono, D1, R2, Queue bindings"
```

---

## Task 2: Node Classifier

**Files:**
- Create: `src/classifier.ts`
- Create: `src/classifier.test.ts`

**Step 1: Write failing tests**

Create `src/classifier.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { classifyNode, hasWebGLMarkers } from "./classifier";

const FILTER_SOURCE = `
const fragmentShader = \`
precision mediump float;
uniform sampler2D u_input_texture;
uniform float u_threshold;
varying vec2 v_uv;
void main() {
  vec3 col = texture2D(u_input_texture, v_uv).rgb;
  float b = step(u_threshold, col.r);
  gl_FragColor = vec4(b, b, b, 1.0);
}
\`;
const imageIn = node.imageIn('in');
const thresholdIn = node.numberIn('threshold', 0.5);
const imageOut = node.imageOut('out');
let program, framebuffer;
node.onStart = () => {
  program = figment.createShaderProgram(fragmentShader);
  framebuffer = new figment.Framebuffer();
};
node.onRender = () => {
  if (!imageIn.value) return;
  framebuffer.setSize(imageIn.value.width, imageIn.value.height);
  framebuffer.bind();
  figment.clear();
  figment.drawQuad(program, { u_input_texture: imageIn.value.texture, u_threshold: thresholdIn.value });
  framebuffer.unbind();
  imageOut.set(framebuffer);
};
`;

const GENERATOR_SOURCE = `
const fragmentShader = \`
precision mediump float;
uniform vec4 u_color;
varying vec2 v_uv;
void main() {
  gl_FragColor = u_color;
}
\`;
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
  figment.drawQuad(program, { u_color: [colorIn.value[0]/255, colorIn.value[1]/255, colorIn.value[2]/255, colorIn.value[3]] });
  framebuffer.unbind();
  imageOut.set(framebuffer);
};
`;

const FEEDBACK_SOURCE = `
const fragmentShader = \`
precision mediump float;
uniform sampler2D u_input_texture;
uniform sampler2D u_prev_texture;
uniform vec2 u_resolution;
varying vec2 v_uv;
void main() {
  vec4 current = texture2D(u_input_texture, v_uv);
  vec4 prev = texture2D(u_prev_texture, v_uv);
  gl_FragColor = mix(prev, current, 0.1);
}
\`;
const imageIn = node.imageIn('in');
const imageOut = node.imageOut('out');
let program, framebuffer, pingPongFramebuffers;
node.onStart = () => {
  program = figment.createShaderProgram(fragmentShader);
  framebuffer = new figment.Framebuffer();
  pingPongFramebuffers = [new figment.Framebuffer(), new figment.Framebuffer()];
};
node.onRender = () => {
  if (!imageIn.value) return;
  for (let i = 0; i < 10; i++) {
    pingPongFramebuffers[1].bind();
    figment.drawQuad(program, { u_input_texture: pingPongFramebuffers[0].texture });
    pingPongFramebuffers[1].unbind();
    const temp = pingPongFramebuffers[0];
    pingPongFramebuffers[0] = pingPongFramebuffers[1];
    pingPongFramebuffers[1] = temp;
  }
  imageOut.set(framebuffer);
};
`;

const RAW_SOURCE = `
const imageIn1 = node.imageIn('image 1');
const imageIn2 = node.imageIn('image 2');
const imageOut = node.imageOut('out');
let program1, program2, framebuffer;
node.onStart = () => {
  program1 = figment.createShaderProgram(shader1);
  program2 = figment.createShaderProgram(shader2);
  framebuffer = new figment.Framebuffer();
};
`;

const WEBGPU_SOURCE = `
figment.createImageFilter(node, {
  label: 'grayscale',
  wgsl: \`
    let color = textureSample(u_input_texture, defaultSampler, in.uv);
    return vec4f(color.r, color.r, color.r, 1.0);
  \`,
});
`;

describe("hasWebGLMarkers", () => {
  it("detects WebGL code", () => {
    expect(hasWebGLMarkers(FILTER_SOURCE)).toBe(true);
  });

  it("returns false for WebGPU code", () => {
    expect(hasWebGLMarkers(WEBGPU_SOURCE)).toBe(false);
  });
});

describe("classifyNode", () => {
  it("classifies a simple image filter", () => {
    expect(classifyNode(FILTER_SOURCE)).toBe("filter");
  });

  it("classifies an image generator", () => {
    expect(classifyNode(GENERATOR_SOURCE)).toBe("generator");
  });

  it("classifies a feedback filter", () => {
    expect(classifyNode(FEEDBACK_SOURCE)).toBe("feedback");
  });

  it("classifies a multi-pipeline node as raw", () => {
    expect(classifyNode(RAW_SOURCE)).toBe("raw");
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run src/classifier.test.ts
```

Expected: FAIL — module not found.

**Step 3: Implement classifier**

Create `src/classifier.ts`:

```ts
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
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run src/classifier.test.ts
```

Expected: all 6 tests PASS.

**Step 5: Commit**

```bash
git add src/classifier.ts src/classifier.test.ts
git commit -m "feat: add node classification heuristic (generator/filter/feedback/raw)"
```

---

## Task 3: Structural Validator

**Files:**
- Create: `src/validator.ts`
- Create: `src/validator.test.ts`

**Step 1: Write failing tests**

Create `src/validator.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { validateConversion } from "./validator";

describe("validateConversion", () => {
  it("accepts valid createImageFilter output", () => {
    const source = `
/**
 * @name Threshold
 * @description Threshold filter
 * @category image
 */
const thresholdIn = node.numberIn('threshold', 0.5);
figment.createImageFilter(node, {
  label: 'threshold',
  uniforms: { u_threshold: 'f32' },
  wgsl: \`
    let col = textureSample(u_input_texture, defaultSampler, in.uv).rgb;
    return vec4f(col.r, col.r, col.r, 1.0);
  \`,
  getUniforms: () => ({ u_threshold: thresholdIn.value }),
});
`;
    const result = validateConversion(source);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts valid createImageGenerator output", () => {
    const source = `
figment.createImageGenerator(node, {
  label: 'constant',
  wgsl: \`return u.u_color;\`,
});
`;
    const result = validateConversion(source);
    expect(result.valid).toBe(true);
  });

  it("accepts valid createFeedbackFilter output", () => {
    const source = `
const result = figment.createFeedbackFilter(node, {
  label: 'trail',
  wgsl: \`return vec4f(0.0);\`,
});
`;
    const result = validateConversion(source);
    expect(result.valid).toBe(true);
  });

  it("accepts raw WGSL with generateWgslPreamble", () => {
    const source = `
const preamble = figment.generateWgslPreamble({ uniforms: {}, textures: [] });
const pipeline = figment.createRenderPipeline({ wgsl: preamble });
`;
    const result = validateConversion(source);
    expect(result.valid).toBe(true);
  });

  it("rejects output containing WebGL markers", () => {
    const source = `
figment.createImageFilter(node, {
  label: 'broken',
  wgsl: \`gl_FragColor = vec4(1.0);\`,
});
`;
    const result = validateConversion(source);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Output still contains WebGL marker: gl_FragColor");
  });

  it("rejects output with no WebGPU helper or preamble", () => {
    const source = `
const x = 42;
console.log(x);
`;
    const result = validateConversion(source);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "Output must contain figment.createImageFilter, figment.createImageGenerator, figment.createFeedbackFilter, or figment.generateWgslPreamble"
    );
  });

  it("rejects output that contains figment.createShaderProgram", () => {
    const source = `
figment.createImageFilter(node, { label: 'x', wgsl: '' });
program = figment.createShaderProgram(shader);
`;
    const result = validateConversion(source);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Output still contains WebGL marker: figment.createShaderProgram(");
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run src/validator.test.ts
```

Expected: FAIL.

**Step 3: Implement validator**

Create `src/validator.ts`:

```ts
const WEBGL_REJECT_MARKERS = [
  "gl_FragColor",
  "texture2D(",
  "figment.createShaderProgram(",
  "new figment.Framebuffer(",
  "framebuffer.bind()",
  "figment.drawQuad(",
];

const WEBGPU_REQUIRED_PATTERNS = [
  "figment.createImageFilter(",
  "figment.createImageGenerator(",
  "figment.createFeedbackFilter(",
  "figment.generateWgslPreamble(",
];

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateConversion(source: string): ValidationResult {
  const errors: string[] = [];

  for (const marker of WEBGL_REJECT_MARKERS) {
    if (source.includes(marker)) {
      errors.push(`Output still contains WebGL marker: ${marker}`);
    }
  }

  const hasWebGPUPattern = WEBGPU_REQUIRED_PATTERNS.some((p) =>
    source.includes(p),
  );
  if (!hasWebGPUPattern) {
    errors.push(
      "Output must contain figment.createImageFilter, figment.createImageGenerator, figment.createFeedbackFilter, or figment.generateWgslPreamble",
    );
  }

  return { valid: errors.length === 0, errors };
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run src/validator.test.ts
```

Expected: all 7 tests PASS.

**Step 5: Commit**

```bash
git add src/validator.ts src/validator.test.ts
git commit -m "feat: add structural validation for AI conversion output"
```

---

## Task 4: AI Converter (Anthropic SDK Integration)

**Files:**
- Create: `src/converter.ts`
- Create: `src/converter.test.ts`

**Step 1: Write failing tests**

Create `src/converter.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildPrompt, SYSTEM_PROMPT } from "./converter";

describe("buildPrompt", () => {
  it("includes classification hint", () => {
    const msg = buildPrompt("filter", "const x = 1;");
    expect(msg).toContain("CLASSIFICATION: filter");
  });

  it("includes source code", () => {
    const source = "const fragmentShader = `precision mediump float;`;";
    const msg = buildPrompt("generator", source);
    expect(msg).toContain(source);
  });
});

describe("SYSTEM_PROMPT", () => {
  it("contains GLSL to WGSL translation rules", () => {
    expect(SYSTEM_PROMPT).toContain("gl_FragColor");
    expect(SYSTEM_PROMPT).toContain("textureSample");
    expect(SYSTEM_PROMPT).toContain("vec4f");
  });

  it("contains all four few-shot examples", () => {
    expect(SYSTEM_PROMPT).toContain("Example 1: Image Filter");
    expect(SYSTEM_PROMPT).toContain("Example 2: Image Generator");
    expect(SYSTEM_PROMPT).toContain("Example 3: Feedback Filter");
    expect(SYSTEM_PROMPT).toContain("Example 4: Simple Filter");
  });

  it("contains helper API documentation", () => {
    expect(SYSTEM_PROMPT).toContain("createImageFilter");
    expect(SYSTEM_PROMPT).toContain("createImageGenerator");
    expect(SYSTEM_PROMPT).toContain("createFeedbackFilter");
    expect(SYSTEM_PROMPT).toContain("generateWgslPreamble");
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run src/converter.test.ts
```

Expected: FAIL.

**Step 3: Implement converter**

Create `src/converter.ts`. This file contains the full system prompt from SPEC.md and the Anthropic SDK call logic:

```ts
import Anthropic from "@anthropic-ai/sdk";
import type { NodeClassification } from "./types";
import { validateConversion } from "./validator";

export const SYSTEM_PROMPT = `You are a code migration assistant that converts Figment creative coding nodes from WebGL to WebGPU. You perform mechanical, faithful conversions — the visual/functional output of the node MUST remain identical.

## Rules

### GLSL to WGSL Shader Translation

| GLSL (old)                          | WGSL (new)                                      |
|-------------------------------------|--------------------------------------------------|
| \`precision mediump float;\`          | Remove entirely                                  |
| \`varying vec2 v_uv;\`               | Remove (use \`in.uv\` from VertexOutput)           |
| \`uniform sampler2D name;\`          | Remove (declared by preamble/helper)             |
| \`uniform float name;\`              | Remove (declared in uniforms object)             |
| \`uniform vec2 name;\`               | Remove (declared in uniforms object)             |
| \`uniform vec3 name;\`               | Remove (declared in uniforms object)             |
| \`uniform vec4 name;\`               | Remove (declared in uniforms object)             |
| \`void main() { ... }\`             | Fragment body or \`@fragment fn fs_main(in: VertexOutput) -> @location(0) vec4f { ... }\` |
| \`gl_FragColor = expr;\`            | \`return expr;\`                                   |
| \`texture2D(sampler, uv)\`          | \`textureSample(texture_name, defaultSampler, uv)\` |
| \`vec2(x, y)\`                      | \`vec2f(x, y)\`                                   |
| \`vec3(x, y, z)\`                   | \`vec3f(x, y, z)\`                                |
| \`vec4(x, y, z, w)\`                | \`vec4f(x, y, z, w)\`                             |
| \`float\`                            | \`f32\`                                            |
| \`int\`                              | \`i32\`                                            |
| \`bool\`                             | \`bool\`                                           |
| \`mat4\`                             | \`mat4x4f\`                                        |
| \`v_uv\`                             | \`in.uv\`                                         |
| \`name\` (uniform access)           | \`u.name\` (accessed via uniform struct)           |
| \`mix(a, b, t)\`                    | \`mix(a, b, t)\` (same)                           |
| \`step(edge, x)\`                   | \`step(edge, x)\` (same)                          |
| \`mod(x, y)\`                       | \`x % y\` or \`fract(x)\` for mod(x, 1.0)          |
| \`atan(y, x)\`                      | \`atan2(y, x)\`                                   |
| \`float x = expr;\`                 | \`var x = expr;\` or \`let x = expr;\`              |
| \`vec3 x = expr;\`                  | \`var x = expr;\` or \`let x = expr;\`              |

Use \`let\` for immutable bindings, \`var\` when the variable is reassigned later.

### GLSL to WGSL Type Mapping for Uniforms

| GLSL uniform type | WGSL type in uniforms object |
|--------------------|-------------------------------|
| \`float\`            | \`'f32'\`                       |
| \`vec2\`             | \`'vec2f'\`                     |
| \`vec3\`             | \`'vec3f'\`                     |
| \`vec4\`             | \`'vec4f'\`                     |
| \`mat4\`             | \`'mat4x4f'\`                   |

### WebGL API to WebGPU API Translation

| WebGL (old)                                         | WebGPU (new)                                     |
|-----------------------------------------------------|--------------------------------------------------|
| \`figment.createShaderProgram(fragmentShader)\`       | Removed — handled by helper                      |
| \`new figment.Framebuffer()\`                          | Removed — handled by helper                      |
| \`new figment.Framebuffer(w, h)\`                      | Removed — handled by helper                      |
| \`framebuffer.setSize(w, h)\`                          | Removed — handled by helper                      |
| \`framebuffer.bind()\` / \`framebuffer.unbind()\`       | Removed — handled by helper                      |
| \`figment.clear()\`                                    | Removed — handled by helper                      |
| \`figment.drawQuad(program, uniforms)\`                | Removed — handled by helper                      |
| \`imageOut.set(framebuffer)\`                          | Removed — handled by helper                      |
| \`node.onStart = () => { ... }\`                       | Removed — handled by helper                      |
| \`node.onRender = () => { ... }\`                      | Removed — handled by helper                      |
| \`node.onStop = () => { ... }\`                        | Removed — handled by helper                      |
| \`imageIn.value.texture\` (passed to drawQuad)         | Removed — helper binds \`u_input_texture\` automatically |
| \`[colorIn.value[0]/255, colorIn.value[1]/255, ...]\` | \`figment.colorToVec3(colorIn.value)\` or \`figment.colorToVec4(colorIn.value)\` |

### Texture Name Mapping

| Old name           | New name              |
|--------------------|-----------------------|
| \`u_input_texture\`  | \`u_input_texture\` (same) |
| \`u_prev_texture\`   | \`u_feedback_texture\`  |
| Any custom sampler2D used for the main input | \`u_input_texture\` |
| Any custom sampler2D used for feedback/previous frame | \`u_feedback_texture\` |

### Critical Constraints

1. **Functional equivalence**: The converted node MUST produce the same visual output as the original. Do not change the algorithm, math, or logic.
2. **Preserve JSDoc comments**: Keep the \`@name\`, \`@description\`, and \`@category\` annotations exactly as they are.
3. **Preserve parameter definitions**: Keep all \`node.numberIn()\`, \`node.colorIn()\`, \`node.selectIn()\`, \`node.triggerButtonIn()\` etc. with the same names, defaults, and ranges.
4. **Use helpers when possible**: If the node is classified as generator/filter/feedback, use \`figment.createImageGenerator\`, \`figment.createImageFilter\`, or \`figment.createFeedbackFilter\` respectively. Only use raw API for nodes classified as "raw".
5. **Remove all boilerplate**: The WebGPU helpers handle pipeline creation, render targets, size management, null-input guards, and cleanup. Remove ALL of: \`let program, framebuffer\`, \`node.onStart\`, \`node.onRender\`, \`node.onStop\`, \`framebuffer.bind/unbind\`, \`figment.clear()\`, \`figment.drawQuad()\`.
6. **WGSL fragment body vs full function**: If the shader has helper functions (anything defined before \`void main()\`), use the full \`@fragment fn fs_main(in: VertexOutput) -> @location(0) vec4f { ... }\` form with the helpers placed before it. If the shader is just a simple main body, use the fragment body form (no \`@fragment\` keyword — the helper will wrap it).
7. **Uniform access**: All uniforms are accessed via \`u.uniform_name\` in WGSL (through the Uniforms struct).
8. **Output only the converted source code.** No explanations, no markdown fences, no commentary.

## Node Type Helpers

### createImageFilter — for single-input, single-output filter nodes

\`\`\`js
figment.createImageFilter(node, {
  label: 'nodeName',           // short identifier
  uniforms: { u_name: 'f32' }, // uniform declarations (WGSL types)
  wgsl: \\\`...\\\`,                 // WGSL fragment body or full @fragment fn
  getUniforms: () => ({        // called each frame to provide uniform values
    u_name: someInput.value,
  }),
});
\`\`\`

The helper automatically:
- Creates \`node.imageIn('in')\` and \`node.imageOut('out')\`
- Handles pipeline creation, render target, size management, null-input guards, cleanup
- Binds \`u_input_texture\` automatically (available in WGSL)
- Provides \`in.uv\` for texture coordinates
- Provides \`defaultSampler\` for texture sampling

### createImageGenerator — for nodes that produce output without image input

\`\`\`js
figment.createImageGenerator(node, {
  label: 'nodeName',
  uniforms: { u_color: 'vec4f' },
  wgsl: \\\`return u.u_color;\\\`,
  getUniforms: () => ({ u_color: figment.colorToVec4(colorIn.value) }),
  getSize: () => ({ width: widthIn.value, height: heightIn.value }),
});
\`\`\`

The helper automatically:
- Creates \`node.imageOut('out')\`
- Handles pipeline creation, render target, cleanup
- Calls \`getSize()\` each frame to set output dimensions

### createFeedbackFilter — for temporal feedback / ping-pong nodes

\`\`\`js
const result = figment.createFeedbackFilter(node, {
  label: 'nodeName',
  uniforms: { u_fade: 'f32' },
  wgsl: \\\`...\\\`,
  getUniforms: () => ({ u_fade: fadeIn.value }),
  iterations: () => iterationsIn.value,  // optional, default 1
});
\`\`\`

The helper automatically:
- Creates \`node.imageIn('in')\` and \`node.imageOut('out')\`
- Manages a \`PingPongTarget\` (double-buffered render targets)
- Binds \`u_feedback_texture\` (previous frame) and \`u_input_texture\` (current input)
- Supports multiple iterations per frame
- Returns \`{ pp, ... }\` for manual reset:

\`\`\`js
resetIn.onTrigger = () => {
  result.pp.destroy();
  result.pp = new figment.PingPongTarget();
};
\`\`\`

### Raw WGSL — for complex nodes

Complex nodes use \`figment.generateWgslPreamble()\` directly:

\`\`\`js
const preamble = figment.generateWgslPreamble({
  uniforms: { u_threshold: 'f32', u_color: 'vec3f' },
  textures: ['u_input_texture'],
});
\`\`\`

Then manually call \`figment.createRenderPipeline()\`, \`figment.drawFullscreen()\`, etc. Convert the shader to WGSL but keep the lifecycle management manual.

## Few-Shot Examples

### Example 1: Image Filter (Chroma Key)

INPUT (WebGL):
\`\`\`js
/**
 * @name Chroma Key
 * @description Make pixels of a certain color transparent, like green screen effect.
 * @category image
 */

const fragmentShader = \\\`
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
\\\`;

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
\`\`\`

OUTPUT (WebGPU):
\`\`\`js
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
  wgsl: \\\`
    var color = textureSample(u_input_texture, defaultSampler, in.uv);
    let difference = length(color.rgb - u.u_keyColor);
    if (difference < u.u_threshold) {
      color.a = 0.0;
    }
    return color;
  \\\`,
  getUniforms: () => ({
    u_keyColor: figment.colorToVec3(colorIn.value),
    u_threshold: thresholdIn.value,
  }),
});
\`\`\`

### Example 2: Image Generator (Constant Color)

INPUT (WebGL):
\`\`\`js
/**
 * @name Constant
 * @description Render a constant color.
 * @category image
 */

const fragmentShader = \\\`
precision mediump float;
uniform vec4 u_color;
varying vec2 v_uv;
void main() {
  gl_FragColor = u_color;
}
\\\`;

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
\`\`\`

OUTPUT (WebGPU):
\`\`\`js
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
  wgsl: \\\`return u.u_color;\\\`,
  getUniforms: () => ({ u_color: figment.colorToVec4(colorIn.value) }),
  getSize: () => ({ width: widthIn.value, height: heightIn.value }),
});
\`\`\`

### Example 3: Feedback Filter (Reaction Diffusion)

INPUT (WebGL):
\`\`\`js
/**
 * @name Reaction Diffusion
 * @description Reaction diffusion on input image.
 * @category image
 */

const fragmentShader = \\\`
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
\\\`;

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
\`\`\`

OUTPUT (WebGPU):
\`\`\`js
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
  wgsl: \\\`
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
  \\\`,
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
\`\`\`

### Example 4: Simple Filter (Threshold)

INPUT (WebGL):
\`\`\`js
/**
 * @name Threshold
 * @description Change brightness threshold of input image.
 * @category image
 */

const fragmentShader = \\\`
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
\\\`;

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
\`\`\`

OUTPUT (WebGPU):
\`\`\`js
/**
 * @name Threshold
 * @description Change brightness threshold of input image.
 * @category image
 */

const thresholdIn = node.numberIn('threshold', 0.5, { min: 0, max: 1, step: 0.01 });

figment.createImageFilter(node, {
  label: 'threshold',
  uniforms: { u_threshold: 'f32' },
  wgsl: \\\`
    let col = textureSample(u_input_texture, defaultSampler, in.uv).rgb;
    let brightness = 0.33333 * (col.r + col.g + col.b);
    let b = mix(0.0, 1.0, step(u.u_threshold, brightness));
    return vec4f(b, b, b, 1.0);
  \\\`,
  getUniforms: () => ({ u_threshold: thresholdIn.value }),
});
\`\`\`

### Important Notes for Feedback Filters

In the old WebGL code, feedback nodes often use confusing texture naming. The pattern is:
- The "ping-pong" texture (previous frame / iterative state) was often sampled from \`u_input_texture\` in the old code (because \`drawQuad\` passed \`pingPongFramebuffers[0].texture\` as \`u_input_texture\`)
- The "live input" texture (current camera/video frame) was often passed as \`u_prev_texture\`

In the new WebGPU code, the naming is canonical:
- \`u_feedback_texture\` = previous frame / iterative state (from PingPongTarget)
- \`u_input_texture\` = current live input

You MUST carefully trace which texture is which by looking at what's passed in the \`drawQuad\` call, NOT by the uniform name. Map them correctly to the new canonical names.`;

export function buildPrompt(
  classification: NodeClassification,
  source: string,
): string {
  return `Convert this Figment node from WebGL to WebGPU.

CLASSIFICATION: ${classification}

SOURCE CODE:
${source}`;
}

export async function convertNode(
  apiKey: string,
  classification: NodeClassification,
  source: string,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const client = new Anthropic({ apiKey });

  for (let attempt = 0; attempt < 2; attempt++) {
    let userMessage = buildPrompt(classification, source);

    if (attempt > 0) {
      const validation = validateConversion(lastOutput);
      userMessage += `\n\nYour previous output had validation errors: ${validation.errors.join("; ")}. Please fix these issues.`;
    }

    let lastOutput = "";
    try {
      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      });

      const textBlock = response.content.find((b) => b.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        return { success: false, error: "No text in AI response" };
      }

      lastOutput = textBlock.text.trim();

      // Strip markdown code fences if the AI wraps them despite instructions
      if (lastOutput.startsWith("```")) {
        lastOutput = lastOutput
          .replace(/^```(?:js|javascript)?\n?/, "")
          .replace(/\n?```$/, "");
      }

      const validation = validateConversion(lastOutput);
      if (validation.valid) {
        return { success: true, output: lastOutput };
      }

      if (attempt === 1) {
        return {
          success: false,
          error: `Validation failed after retry: ${validation.errors.join("; ")}`,
        };
      }
    } catch (err) {
      return {
        success: false,
        error: `API error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return { success: false, error: "Unexpected: exhausted retries" };
}
```

Note: The `convertNode` function has a variable scoping issue above — `lastOutput` needs to be declared outside the loop. Here is the corrected version of the retry logic:

```ts
export async function convertNode(
  apiKey: string,
  classification: NodeClassification,
  source: string,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const client = new Anthropic({ apiKey });
  let lastOutput = "";
  let lastErrors: string[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    let userMessage = buildPrompt(classification, source);

    if (attempt > 0 && lastErrors.length > 0) {
      userMessage += `\n\nYour previous output had validation errors: ${lastErrors.join("; ")}. Please fix these issues.`;
    }

    try {
      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      });

      const textBlock = response.content.find((b) => b.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        return { success: false, error: "No text in AI response" };
      }

      lastOutput = textBlock.text.trim();

      // Strip markdown code fences if the AI wraps them despite instructions
      if (lastOutput.startsWith("```")) {
        lastOutput = lastOutput
          .replace(/^```(?:js|javascript)?\n?/, "")
          .replace(/\n?```$/, "");
      }

      const validation = validateConversion(lastOutput);
      if (validation.valid) {
        return { success: true, output: lastOutput };
      }

      lastErrors = validation.errors;

      if (attempt === 1) {
        return {
          success: false,
          error: `Validation failed after retry: ${lastErrors.join("; ")}`,
        };
      }
    } catch (err) {
      return {
        success: false,
        error: `API error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return { success: false, error: "Unexpected: exhausted retries" };
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run src/converter.test.ts
```

Expected: all 5 tests PASS (only testing prompt building and system prompt content, not the API call).

**Step 5: Commit**

```bash
git add src/converter.ts src/converter.test.ts
git commit -m "feat: add AI converter with Anthropic SDK, system prompt, and retry logic"
```

---

## Task 5: API Routes

**Files:**
- Modify: `src/index.ts`
- Create: `src/routes/api.ts`

**Step 1: Create API routes**

Create `src/routes/api.ts`:

```ts
import { Hono } from "hono";
import type { Env, FgmtFile, QueueMessage } from "../types";
import { hasWebGLMarkers } from "../classifier";

const api = new Hono<{ Bindings: Env }>();

function generateTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

api.post("/migrate-to-webgpu", async (c) => {
  const contentType = c.req.header("content-type") || "";

  let inputType: "fgmt" | "source";
  let inputData: string;
  let nodeCount: number;

  if (contentType.includes("multipart/form-data")) {
    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;
    const source = formData.get("source") as string | null;

    if (file) {
      inputType = "fgmt";
      inputData = await file.text();

      let fgmt: FgmtFile;
      try {
        fgmt = JSON.parse(inputData);
      } catch {
        return c.json({ error: "Invalid JSON in .fgmt file" }, 400);
      }

      if (!fgmt.types || !Array.isArray(fgmt.types)) {
        return c.json({ error: "No types array found in .fgmt file" }, 400);
      }

      const webglTypes = fgmt.types.filter((t) => hasWebGLMarkers(t.source));
      nodeCount = webglTypes.length;

      if (nodeCount === 0) {
        return c.json({
          status: "completed",
          message: "No custom WebGL nodes found. File is already compatible.",
        });
      }
    } else if (source) {
      inputType = "source";
      inputData = JSON.stringify({ source });
      nodeCount = 1;

      if (!hasWebGLMarkers(source)) {
        return c.json({
          status: "completed",
          message: "Source code does not contain WebGL markers. Already compatible.",
        });
      }
    } else {
      return c.json({ error: "Provide either a 'file' or 'source' field" }, 400);
    }
  } else if (contentType.includes("application/json")) {
    const body = await c.req.json<{ source?: string }>();
    if (!body.source) {
      return c.json({ error: "Provide a 'source' field" }, 400);
    }
    inputType = "source";
    inputData = JSON.stringify({ source: body.source });
    nodeCount = 1;

    if (!hasWebGLMarkers(body.source)) {
      return c.json({
        status: "completed",
        message: "Source code does not contain WebGL markers. Already compatible.",
      });
    }
  } else {
    return c.json({ error: "Unsupported content type" }, 400);
  }

  const taskId = generateTaskId();
  const inputKey = `inputs/${taskId}.json`;

  // Store input in R2
  await c.env.STORAGE.put(inputKey, inputData);

  // Create D1 task row
  await c.env.DB.prepare(
    `INSERT INTO tasks (id, status, input_type, node_count, nodes_completed, input_key)
     VALUES (?, 'queued', ?, ?, 0, ?)`,
  )
    .bind(taskId, inputType, nodeCount, inputKey)
    .run();

  // Enqueue for processing
  await c.env.MIGRATION_QUEUE.send({ taskId } satisfies QueueMessage);

  return c.json({
    id: taskId,
    status: "queued",
    nodeCount,
    message: `Migration queued. Poll /api/migrate-to-webgpu/status?id=${taskId} for progress.`,
  });
});

api.get("/migrate-to-webgpu/status", async (c) => {
  const taskId = c.req.query("id");
  if (!taskId) {
    return c.json({ error: "Missing 'id' query parameter" }, 400);
  }

  const task = await c.env.DB.prepare("SELECT * FROM tasks WHERE id = ?")
    .bind(taskId)
    .first();

  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }

  return c.json({
    id: task.id,
    status: task.status,
    nodeCount: task.node_count,
    nodesCompleted: task.nodes_completed,
    errors: task.errors ? JSON.parse(task.errors as string) : [],
  });
});

api.get("/migrate-to-webgpu/result", async (c) => {
  const taskId = c.req.query("id");
  if (!taskId) {
    return c.json({ error: "Missing 'id' query parameter" }, 400);
  }

  const task = await c.env.DB.prepare(
    "SELECT status, input_type, output_key FROM tasks WHERE id = ?",
  )
    .bind(taskId)
    .first();

  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }

  if (task.status !== "completed" && task.status !== "partial") {
    return c.json({ error: "Task not completed", status: task.status }, 202);
  }

  const outputKey = task.output_key as string;
  const obj = await c.env.STORAGE.get(outputKey);
  if (!obj) {
    return c.json({ error: "Output file not found" }, 500);
  }

  const data = await obj.text();

  if (task.input_type === "fgmt") {
    return new Response(data, {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="migrated-${taskId}.fgmt"`,
      },
    });
  } else {
    const parsed = JSON.parse(data);
    return new Response(parsed.source, {
      headers: { "Content-Type": "text/plain" },
    });
  }
});

export { api };
```

**Step 2: Update src/index.ts to mount routes**

```ts
import { Hono } from "hono";
import type { Env } from "./types";
import { api } from "./routes/api";

const app = new Hono<{ Bindings: Env }>();

app.route("/api", api);

app.get("/", (c) => c.text("Figment Migration Service"));

export default {
  fetch: app.fetch,
};
```

**Step 3: Verify types**

```bash
npm run typecheck
```

Expected: no errors.

**Step 4: Commit**

```bash
git add src/index.ts src/routes/api.ts
git commit -m "feat: add API routes for migrate-to-webgpu (POST, status, result)"
```

---

## Task 6: Queue Consumer

**Files:**
- Create: `src/queue.ts`
- Modify: `src/index.ts` (add queue handler export)

**Step 1: Create queue consumer**

Create `src/queue.ts`:

```ts
import type { Env, FgmtFile, QueueMessage, ConversionResult } from "./types";
import { classifyNode, hasWebGLMarkers } from "./classifier";
import { convertNode } from "./converter";

export async function handleQueue(
  batch: MessageBatch<QueueMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    const { taskId } = message.body;

    try {
      await processTask(taskId, env);
      message.ack();
    } catch (err) {
      console.error(`Task ${taskId} failed:`, err);

      await env.DB.prepare(
        `UPDATE tasks SET status = 'failed', errors = ?, updated_at = datetime('now') WHERE id = ?`,
      )
        .bind(
          JSON.stringify([
            {
              error:
                err instanceof Error ? err.message : String(err),
            },
          ]),
          taskId,
        )
        .run();

      message.ack(); // Don't retry on application-level failures
    }
  }
}

async function processTask(taskId: string, env: Env): Promise<void> {
  // Mark as processing
  await env.DB.prepare(
    `UPDATE tasks SET status = 'processing', updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(taskId)
    .run();

  // Read input from R2
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?")
    .bind(taskId)
    .first();

  if (!task) throw new Error("Task not found");

  const inputObj = await env.STORAGE.get(task.input_key as string);
  if (!inputObj) throw new Error("Input file not found in R2");

  const inputData = await inputObj.text();

  if (task.input_type === "source") {
    await processSourceCode(taskId, inputData, env);
  } else {
    await processFgmtFile(taskId, inputData, env);
  }
}

async function processSourceCode(
  taskId: string,
  inputData: string,
  env: Env,
): Promise<void> {
  const { source } = JSON.parse(inputData);
  const classification = classifyNode(source);
  const result = await convertNode(env.ANTHROPIC_API_KEY, classification, source);

  const outputKey = `outputs/${taskId}.json`;

  if (result.success) {
    await env.STORAGE.put(outputKey, JSON.stringify({ source: result.output }));
    await env.DB.prepare(
      `UPDATE tasks SET status = 'completed', nodes_completed = 1, output_key = ?, updated_at = datetime('now') WHERE id = ?`,
    )
      .bind(outputKey, taskId)
      .run();
  } else {
    await env.STORAGE.put(
      outputKey,
      JSON.stringify({
        source: `// MIGRATION FAILED: ${result.error}\n// Original WebGL code preserved.\n${source}`,
      }),
    );
    await env.DB.prepare(
      `UPDATE tasks SET status = 'failed', output_key = ?, errors = ?, updated_at = datetime('now') WHERE id = ?`,
    )
      .bind(
        outputKey,
        JSON.stringify([{ typeName: "source", error: result.error }]),
        taskId,
      )
      .run();
  }
}

async function processFgmtFile(
  taskId: string,
  inputData: string,
  env: Env,
): Promise<void> {
  const fgmt: FgmtFile = JSON.parse(inputData);
  const errors: ConversionResult[] = [];
  let nodesCompleted = 0;

  for (const type of fgmt.types) {
    if (!hasWebGLMarkers(type.source)) {
      continue; // Already WebGPU or non-shader
    }

    const classification = classifyNode(type.source);
    const result = await convertNode(
      env.ANTHROPIC_API_KEY,
      classification,
      type.source,
    );

    if (result.success) {
      type.source = result.output!;
      nodesCompleted++;
    } else {
      type.source = `// MIGRATION FAILED: ${result.error}\n// Original WebGL code preserved.\n${type.source}`;
      errors.push({
        typeName: type.name,
        success: false,
        error: result.error,
      });
    }

    // Update progress
    await env.DB.prepare(
      `UPDATE tasks SET nodes_completed = ?, updated_at = datetime('now') WHERE id = ?`,
    )
      .bind(nodesCompleted, taskId)
      .run();
  }

  // Bump version
  fgmt.version = 6;

  const outputKey = `outputs/${taskId}.json`;
  await env.STORAGE.put(outputKey, JSON.stringify(fgmt, null, 2));

  const totalWebGL = fgmt.types.filter((t) =>
    t.source.includes("// MIGRATION FAILED") || !t.source.includes("figment.createShaderProgram"),
  ).length;

  let status: string;
  if (errors.length === 0) {
    status = "completed";
  } else if (nodesCompleted > 0) {
    status = "partial";
  } else {
    status = "failed";
  }

  await env.DB.prepare(
    `UPDATE tasks SET status = ?, nodes_completed = ?, output_key = ?, errors = ?, updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(
      status,
      nodesCompleted,
      outputKey,
      errors.length > 0 ? JSON.stringify(errors) : null,
      taskId,
    )
    .run();
}
```

**Step 2: Update src/index.ts to export queue handler**

```ts
import { Hono } from "hono";
import type { Env, QueueMessage } from "./types";
import { api } from "./routes/api";
import { handleQueue } from "./queue";

const app = new Hono<{ Bindings: Env }>();

app.route("/api", api);

app.get("/", (c) => c.text("Figment Migration Service"));

export default {
  fetch: app.fetch,
  queue: handleQueue,
};
```

**Step 3: Verify types**

```bash
npm run typecheck
```

Expected: no errors.

**Step 4: Commit**

```bash
git add src/queue.ts src/index.ts
git commit -m "feat: add queue consumer for async node conversion"
```

---

## Task 7: Cron Cleanup Handler

**Files:**
- Create: `src/cron.ts`
- Modify: `src/index.ts` (add scheduled export)

**Step 1: Create cron handler**

Create `src/cron.ts`:

```ts
import type { Env } from "./types";

export async function handleScheduled(env: Env): Promise<void> {
  // Find expired tasks
  const { results } = await env.DB.prepare(
    `SELECT id, input_key, output_key FROM tasks WHERE created_at < datetime('now', '-24 hours')`,
  ).all();

  if (!results || results.length === 0) return;

  // Delete R2 objects
  for (const task of results) {
    const keysToDelete = [task.input_key as string];
    if (task.output_key) keysToDelete.push(task.output_key as string);

    await Promise.all(keysToDelete.map((key) => env.STORAGE.delete(key)));
  }

  // Delete D1 rows
  const ids = results.map((t) => t.id as string);
  const placeholders = ids.map(() => "?").join(", ");
  await env.DB.prepare(
    `DELETE FROM tasks WHERE id IN (${placeholders})`,
  )
    .bind(...ids)
    .run();
}
```

**Step 2: Update src/index.ts**

```ts
import { Hono } from "hono";
import type { Env, QueueMessage } from "./types";
import { api } from "./routes/api";
import { handleQueue } from "./queue";
import { handleScheduled } from "./cron";

const app = new Hono<{ Bindings: Env }>();

app.route("/api", api);

app.get("/", (c) => c.text("Figment Migration Service"));

export default {
  fetch: app.fetch,
  queue: handleQueue,
  scheduled: (event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(handleScheduled(env));
  },
};
```

**Step 3: Verify types**

```bash
npm run typecheck
```

Expected: no errors.

**Step 4: Commit**

```bash
git add src/cron.ts src/index.ts
git commit -m "feat: add cron cleanup handler for 24-hour file retention"
```

---

## Task 8: Web Frontend

**Files:**
- Create: `src/frontend/index.html`
- Modify: `src/index.ts` (serve static HTML)

**Step 1: Create the HTML frontend**

Create `src/frontend/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Figment Migration</title>
  <style>
    :root {
      --bg: oklch(15% 0 0);
      --fg: oklch(90% 0 0);
      --fg-dim: oklch(60% 0 0);
      --border: oklch(35% 0 0);
      --accent: oklch(70% 0.15 250);
      --accent-dim: oklch(50% 0.15 250);
      --error: oklch(65% 0.2 25);
      --success: oklch(65% 0.15 145);
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
      background: var(--bg);
      color: var(--fg);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 2rem;
    }

    h1 { font-size: 1.2rem; margin-bottom: 0.5rem; }
    .subtitle { color: var(--fg-dim); font-size: 0.85rem; text-align: center; margin-bottom: 2rem; line-height: 1.6; }

    .tabs {
      display: flex;
      gap: 0;
      margin-bottom: 0;
      width: 100%;
      max-width: 700px;
    }

    .tab {
      padding: 0.6rem 1.5rem;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--fg-dim);
      font-family: inherit;
      font-size: 0.85rem;
      cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease;
    }

    .tab:first-child { border-right: none; }
    .tab.active { background: var(--border); color: var(--fg); }
    .tab:hover:not(.active) { color: var(--fg); }

    .panel {
      width: 100%;
      max-width: 700px;
      border: 1px solid var(--border);
      padding: 2rem;
      min-height: 400px;
      display: none;
    }

    .panel.active { display: flex; flex-direction: column; align-items: center; justify-content: center; }

    .drop-zone {
      width: 100%;
      max-width: 400px;
      padding: 3rem 2rem;
      border: 2px dashed var(--border);
      text-align: center;
      cursor: pointer;
      transition: border-color 0.15s ease;
    }

    .drop-zone:hover, .drop-zone.dragover { border-color: var(--accent); }
    .drop-zone p { color: var(--fg-dim); font-size: 0.85rem; margin-bottom: 1rem; }
    .drop-zone .link { color: var(--accent); text-decoration: underline; cursor: pointer; }

    input[type="file"] { display: none; }

    textarea {
      width: 100%;
      min-height: 250px;
      background: oklch(12% 0 0);
      color: var(--fg);
      border: 1px solid var(--border);
      padding: 1rem;
      font-family: inherit;
      font-size: 0.8rem;
      resize: vertical;
    }

    textarea:focus { outline: 1px solid var(--accent); }

    .btn {
      padding: 0.6rem 2rem;
      background: var(--accent-dim);
      color: var(--fg);
      border: none;
      font-family: inherit;
      font-size: 0.85rem;
      cursor: pointer;
      margin-top: 1rem;
      transition: background 0.15s ease;
    }

    .btn:hover { background: var(--accent); }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }

    .status {
      margin-top: 1rem;
      font-size: 0.8rem;
      color: var(--fg-dim);
    }

    .status.error { color: var(--error); }
    .status.success { color: var(--success); }

    .progress-bar {
      width: 100%;
      height: 4px;
      background: var(--border);
      margin-top: 0.5rem;
      display: none;
    }

    .progress-bar .fill {
      height: 100%;
      background: var(--accent);
      width: 0%;
      transition: width 0.3s ease;
    }

    .result-area {
      width: 100%;
      margin-top: 1.5rem;
      display: none;
    }

    .result-area pre {
      background: oklch(12% 0 0);
      border: 1px solid var(--border);
      padding: 1rem;
      font-size: 0.75rem;
      overflow-x: auto;
      max-height: 400px;
      overflow-y: auto;
      white-space: pre;
    }

    .result-actions {
      display: flex;
      gap: 0.5rem;
      margin-top: 0.5rem;
    }
  </style>
</head>
<body>
  <h1>Convert your old Figment project here.</h1>
  <p class="subtitle">
    Newer versions of Figment use WebGPU for performance.<br>
    Your project has custom nodes that are still written in WebGL.
  </p>

  <div class="tabs">
    <button class="tab active" data-tab="file">Project File</button>
    <button class="tab" data-tab="source">Source Code</button>
  </div>

  <!-- File Upload Panel -->
  <div class="panel active" id="panel-file">
    <div class="drop-zone" id="drop-zone">
      <p>Please upload your .fgmt file here</p>
      <span class="link">click here to select</span>
      <input type="file" id="file-input" accept=".fgmt,.json">
    </div>
    <div class="progress-bar" id="file-progress"><div class="fill"></div></div>
    <div class="status" id="file-status"></div>
    <div class="result-actions" id="file-actions" style="display:none">
      <button class="btn" id="download-btn">Download converted file</button>
    </div>
  </div>

  <!-- Source Code Panel -->
  <div class="panel" id="panel-source">
    <textarea id="source-input" placeholder="Paste your WebGL node source code here..."></textarea>
    <button class="btn" id="convert-btn">Convert</button>
    <div class="progress-bar" id="source-progress"><div class="fill"></div></div>
    <div class="status" id="source-status"></div>
    <div class="result-area" id="source-result">
      <pre><code id="result-code"></code></pre>
      <div class="result-actions">
        <button class="btn" id="copy-btn">Copy to clipboard</button>
      </div>
    </div>
  </div>

  <script>
    const tabs = document.querySelectorAll('.tab');
    const panels = document.querySelectorAll('.panel');

    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        panels.forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
      });
    });

    // File upload
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const fileStatus = document.getElementById('file-status');
    const fileProgress = document.getElementById('file-progress');
    const fileActions = document.getElementById('file-actions');
    let downloadTaskId = null;

    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      if (e.dataTransfer.files.length) uploadFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', () => { if (fileInput.files.length) uploadFile(fileInput.files[0]); });

    async function uploadFile(file) {
      fileStatus.textContent = 'Uploading...';
      fileStatus.className = 'status';
      fileProgress.style.display = 'block';
      fileProgress.querySelector('.fill').style.width = '10%';
      fileActions.style.display = 'none';

      const formData = new FormData();
      formData.append('file', file);

      try {
        const res = await fetch('/api/migrate-to-webgpu', { method: 'POST', body: formData });
        const data = await res.json();

        if (data.status === 'completed' && data.message) {
          fileStatus.textContent = data.message;
          fileStatus.className = 'status success';
          fileProgress.querySelector('.fill').style.width = '100%';
          return;
        }

        if (data.error) {
          fileStatus.textContent = data.error;
          fileStatus.className = 'status error';
          return;
        }

        downloadTaskId = data.id;
        fileStatus.textContent = `Queued. Converting ${data.nodeCount} node(s)...`;
        pollStatus(data.id, 'file');
      } catch (err) {
        fileStatus.textContent = 'Upload failed: ' + err.message;
        fileStatus.className = 'status error';
      }
    }

    // Source code conversion
    const convertBtn = document.getElementById('convert-btn');
    const sourceInput = document.getElementById('source-input');
    const sourceStatus = document.getElementById('source-status');
    const sourceProgress = document.getElementById('source-progress');
    const sourceResult = document.getElementById('source-result');
    const resultCode = document.getElementById('result-code');

    convertBtn.addEventListener('click', async () => {
      const source = sourceInput.value.trim();
      if (!source) return;

      convertBtn.disabled = true;
      sourceStatus.textContent = 'Submitting...';
      sourceStatus.className = 'status';
      sourceProgress.style.display = 'block';
      sourceProgress.querySelector('.fill').style.width = '10%';
      sourceResult.style.display = 'none';

      try {
        const res = await fetch('/api/migrate-to-webgpu', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source }),
        });
        const data = await res.json();

        if (data.status === 'completed' && data.message) {
          sourceStatus.textContent = data.message;
          sourceStatus.className = 'status success';
          sourceProgress.querySelector('.fill').style.width = '100%';
          convertBtn.disabled = false;
          return;
        }

        if (data.error) {
          sourceStatus.textContent = data.error;
          sourceStatus.className = 'status error';
          convertBtn.disabled = false;
          return;
        }

        sourceStatus.textContent = 'Converting...';
        pollStatus(data.id, 'source');
      } catch (err) {
        sourceStatus.textContent = 'Error: ' + err.message;
        sourceStatus.className = 'status error';
        convertBtn.disabled = false;
      }
    });

    async function pollStatus(taskId, mode) {
      const statusEl = mode === 'file' ? fileStatus : sourceStatus;
      const progressEl = mode === 'file' ? fileProgress : sourceProgress;

      const poll = async () => {
        try {
          const res = await fetch(`/api/migrate-to-webgpu/status?id=${taskId}`);
          const data = await res.json();

          if (data.status === 'processing') {
            const pct = data.nodeCount > 0
              ? Math.round(10 + (data.nodesCompleted / data.nodeCount) * 80)
              : 50;
            progressEl.querySelector('.fill').style.width = pct + '%';
            statusEl.textContent = `Converting... ${data.nodesCompleted}/${data.nodeCount} nodes`;
            setTimeout(poll, 1500);
            return;
          }

          if (data.status === 'queued') {
            setTimeout(poll, 1500);
            return;
          }

          progressEl.querySelector('.fill').style.width = '100%';

          if (data.status === 'completed' || data.status === 'partial') {
            statusEl.className = data.status === 'completed' ? 'status success' : 'status';
            statusEl.textContent = data.status === 'completed'
              ? 'Conversion complete!'
              : `Partial conversion: ${data.errors.length} node(s) failed.`;

            if (mode === 'file') {
              downloadTaskId = taskId;
              fileActions.style.display = 'flex';
            } else {
              // Fetch and display the result
              const resultRes = await fetch(`/api/migrate-to-webgpu/result?id=${taskId}`);
              const text = await resultRes.text();
              resultCode.textContent = text;
              sourceResult.style.display = 'block';
              convertBtn.disabled = false;
            }
          } else {
            statusEl.textContent = `Conversion failed: ${data.errors?.[0]?.error || 'Unknown error'}`;
            statusEl.className = 'status error';
            if (mode === 'source') convertBtn.disabled = false;
          }
        } catch (err) {
          statusEl.textContent = 'Polling error: ' + err.message;
          statusEl.className = 'status error';
          if (mode === 'source') convertBtn.disabled = false;
        }
      };

      setTimeout(poll, 1500);
    }

    // Download
    document.getElementById('download-btn').addEventListener('click', () => {
      if (downloadTaskId) {
        window.location.href = `/api/migrate-to-webgpu/result?id=${downloadTaskId}`;
      }
    });

    // Copy
    document.getElementById('copy-btn').addEventListener('click', () => {
      navigator.clipboard.writeText(resultCode.textContent);
      document.getElementById('copy-btn').textContent = 'Copied!';
      setTimeout(() => { document.getElementById('copy-btn').textContent = 'Copy to clipboard'; }, 2000);
    });
  </script>
</body>
</html>
```

**Step 2: Serve the HTML from the worker**

Update `src/index.ts` to serve the frontend. Read the HTML as a raw string import:

```ts
import { Hono } from "hono";
import type { Env, QueueMessage } from "./types";
import { api } from "./routes/api";
import { handleQueue } from "./queue";
import { handleScheduled } from "./cron";
import html from "./frontend/index.html";

const app = new Hono<{ Bindings: Env }>();

app.route("/api", api);

app.get("/", (c) => {
  return c.html(html);
});

export default {
  fetch: app.fetch,
  queue: handleQueue,
  scheduled: (event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(handleScheduled(env));
  },
};
```

Add to `tsconfig.json` a declaration for `.html` imports. Create `src/html.d.ts`:

```ts
declare module "*.html" {
  const content: string;
  export default content;
}
```

Also add `"src/**/*.d.ts"` to the tsconfig `include` if not already covered by `"src/**/*.ts"`.

**Step 3: Verify types and test locally**

```bash
npm run typecheck
```

Expected: no errors.

**Step 4: Commit**

```bash
git add src/frontend/index.html src/index.ts src/html.d.ts
git commit -m "feat: add vanilla HTML frontend with drag-and-drop upload and source code conversion"
```

---

## Task 9: Integration Test with Demo Projects

**Files:**
- Create: `src/integration.test.ts`

**Step 1: Write integration tests**

These test the full pipeline (classifier + validator) using the actual demo files:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { classifyNode, hasWebGLMarkers } from "./classifier";
import { validateConversion } from "./validator";

const DEMO_DIR = resolve(__dirname, "../demo-projects");
const EXAMPLE_DIR = resolve(__dirname, "../example-nodes");

describe("demo project integration", () => {
  it("detects WebGL markers in old .fgmt file", () => {
    const fgmt = JSON.parse(
      readFileSync(resolve(DEMO_DIR, "custom-image-filter-webgl.fgmt"), "utf-8"),
    );
    const webglTypes = fgmt.types.filter((t: any) => hasWebGLMarkers(t.source));
    expect(webglTypes.length).toBe(1);
    expect(webglTypes[0].name).toBe("Custom Threshold");
  });

  it("detects no WebGL markers in new .fgmt file", () => {
    const fgmt = JSON.parse(
      readFileSync(resolve(DEMO_DIR, "custom-image-filter-webgpu.fgmt"), "utf-8"),
    );
    const webglTypes = fgmt.types.filter((t: any) => hasWebGLMarkers(t.source));
    expect(webglTypes.length).toBe(0);
  });

  it("classifies old threshold node as filter", () => {
    const fgmt = JSON.parse(
      readFileSync(resolve(DEMO_DIR, "custom-image-filter-webgl.fgmt"), "utf-8"),
    );
    expect(classifyNode(fgmt.types[0].source)).toBe("filter");
  });

  it("validates new threshold node", () => {
    const fgmt = JSON.parse(
      readFileSync(resolve(DEMO_DIR, "custom-image-filter-webgpu.fgmt"), "utf-8"),
    );
    expect(validateConversion(fgmt.types[0].source).valid).toBe(true);
  });
});

describe("example node classification", () => {
  it("classifies WebGL filter as filter", () => {
    const source = readFileSync(resolve(EXAMPLE_DIR, "image-filter-webgl.js"), "utf-8");
    expect(classifyNode(source)).toBe("filter");
  });

  it("classifies WebGL generator as generator", () => {
    const source = readFileSync(resolve(EXAMPLE_DIR, "image-generator-webgl.js"), "utf-8");
    expect(classifyNode(source)).toBe("generator");
  });

  it("classifies WebGL feedback filter as feedback", () => {
    const source = readFileSync(resolve(EXAMPLE_DIR, "image-feedback-filter-webgl.js"), "utf-8");
    expect(classifyNode(source)).toBe("feedback");
  });
});

describe("example node validation", () => {
  it("validates WebGPU filter", () => {
    const source = readFileSync(resolve(EXAMPLE_DIR, "image-filter-webgpu.js"), "utf-8");
    expect(validateConversion(source).valid).toBe(true);
  });

  it("validates WebGPU generator", () => {
    const source = readFileSync(resolve(EXAMPLE_DIR, "image-generator-webgpu.js"), "utf-8");
    expect(validateConversion(source).valid).toBe(true);
  });

  it("validates WebGPU feedback filter", () => {
    const source = readFileSync(resolve(EXAMPLE_DIR, "image-feedback-filter-webgpu.js"), "utf-8");
    expect(validateConversion(source).valid).toBe(true);
  });
});
```

**Step 2: Run integration tests**

```bash
npx vitest run src/integration.test.ts
```

Expected: all 9 tests PASS.

**Step 3: Run all tests**

```bash
npm test
```

Expected: all tests across classifier, validator, converter, and integration pass.

**Step 4: Commit**

```bash
git add src/integration.test.ts
git commit -m "feat: add integration tests against demo projects and example nodes"
```

---

## Task 10: Create Cloudflare Resources and Deploy

**Files:**
- Modify: `wrangler.toml` (update D1 database ID after creation)

**Step 1: Create D1 database**

```bash
cd /Users/fdb/Projects/figment-migration
wrangler d1 create figment-migration-db
```

Copy the `database_id` from the output and update `wrangler.toml`.

**Step 2: Create R2 bucket**

```bash
wrangler r2 bucket create figment-migration-storage
```

**Step 3: Create Queue**

```bash
wrangler queues create figment-migration-queue
```

**Step 4: Set the Anthropic API key secret**

```bash
wrangler secret put ANTHROPIC_API_KEY
```

(Paste the key when prompted.)

**Step 5: Run the D1 migration**

```bash
npm run db:migrate:local
npm run db:migrate:remote
```

**Step 6: Deploy**

```bash
wrangler deploy
```

**Step 7: Verify the deployment works**

Test with:
```bash
curl -X POST https://figment-migration.<your-subdomain>.workers.dev/api/migrate-to-webgpu \
  -H "Content-Type: application/json" \
  -d '{"source": "const fragmentShader = `precision mediump float; uniform sampler2D u_input_texture; varying vec2 v_uv; void main() { gl_FragColor = texture2D(u_input_texture, v_uv); }`; const imageIn = node.imageIn(\"in\"); const imageOut = node.imageOut(\"out\"); let program, framebuffer; node.onStart = () => { program = figment.createShaderProgram(fragmentShader); framebuffer = new figment.Framebuffer(); }; node.onRender = () => { if (!imageIn.value) return; framebuffer.setSize(imageIn.value.width, imageIn.value.height); framebuffer.bind(); figment.clear(); figment.drawQuad(program, { u_input_texture: imageIn.value.texture }); framebuffer.unbind(); imageOut.set(framebuffer); };"}'
```

**Step 8: Commit final config**

```bash
git add wrangler.toml
git commit -m "chore: configure Cloudflare D1, R2, and Queue resource IDs"
```

---

## Summary

| Task | Component | Tests |
|------|-----------|-------|
| 1 | Project scaffolding | typecheck |
| 2 | Node classifier | 6 unit tests |
| 3 | Structural validator | 7 unit tests |
| 4 | AI converter (Anthropic SDK) | 5 unit tests |
| 5 | API routes | typecheck |
| 6 | Queue consumer | typecheck |
| 7 | Cron cleanup | typecheck |
| 8 | Web frontend (HTML) | typecheck |
| 9 | Integration tests | 9 integration tests |
| 10 | Deploy | manual E2E |
