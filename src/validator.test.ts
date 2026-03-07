import { describe, it, expect } from "vitest";
import { validateConversion } from "./validator";

describe("validateConversion", () => {
  it("accepts valid createImageFilter output", () => {
    const source = `export default figment.createImageFilter({ name: "blur" });`;
    const result = validateConversion(source);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts valid createImageGenerator output", () => {
    const source = `export default figment.createImageGenerator({ name: "noise" });`;
    const result = validateConversion(source);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts valid createFeedbackFilter output", () => {
    const source = `export default figment.createFeedbackFilter({ name: "feedback" });`;
    const result = validateConversion(source);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts raw WGSL with generateWgslPreamble", () => {
    const source = `const preamble = figment.generateWgslPreamble();`;
    const result = validateConversion(source);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects output containing gl_FragColor", () => {
    const source = `gl_FragColor = vec4(1.0);\nfigment.createImageFilter({});`;
    const result = validateConversion(source);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "Output still contains WebGL marker: gl_FragColor"
    );
  });

  it("rejects output with no WebGPU helper or preamble", () => {
    const source = `const x = 42;`;
    const result = validateConversion(source);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "Output must contain figment.createImageFilter, figment.createImageGenerator, figment.createFeedbackFilter, or figment.generateWgslPreamble"
    );
  });

  it("rejects output that contains figment.createShaderProgram(", () => {
    const source = `figment.createShaderProgram(vs, fs);\nfigment.createImageFilter({});`;
    const result = validateConversion(source);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "Output still contains WebGL marker: figment.createShaderProgram("
    );
  });
});
