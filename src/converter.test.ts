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
