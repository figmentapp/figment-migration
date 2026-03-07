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
      readFileSync(resolve(DEMO_DIR, "custom-image-filter-webgl.fgmt"), "utf-8")
    );
    const webglTypes = fgmt.types.filter((t: { source: string }) =>
      hasWebGLMarkers(t.source)
    );
    expect(webglTypes).toHaveLength(1);
    expect(webglTypes[0].name).toBe("Custom Threshold");
  });

  it("detects no WebGL markers in new .fgmt file", () => {
    const fgmt = JSON.parse(
      readFileSync(
        resolve(DEMO_DIR, "custom-image-filter-webgpu.fgmt"),
        "utf-8"
      )
    );
    const webglTypes = fgmt.types.filter((t: { source: string }) =>
      hasWebGLMarkers(t.source)
    );
    expect(webglTypes).toHaveLength(0);
  });

  it("classifies old threshold node as filter", () => {
    const fgmt = JSON.parse(
      readFileSync(resolve(DEMO_DIR, "custom-image-filter-webgl.fgmt"), "utf-8")
    );
    expect(classifyNode(fgmt.types[0].source)).toBe("filter");
  });

  it("validates new threshold node", () => {
    const fgmt = JSON.parse(
      readFileSync(
        resolve(DEMO_DIR, "custom-image-filter-webgpu.fgmt"),
        "utf-8"
      )
    );
    expect(validateConversion(fgmt.types[0].source).valid).toBe(true);
  });
});

describe("example node classification", () => {
  it("classifies WebGL filter as filter", () => {
    const source = readFileSync(
      resolve(EXAMPLE_DIR, "image-filter-webgl.js"),
      "utf-8"
    );
    expect(classifyNode(source)).toBe("filter");
  });

  it("classifies WebGL generator as generator", () => {
    const source = readFileSync(
      resolve(EXAMPLE_DIR, "image-generator-webgl.js"),
      "utf-8"
    );
    expect(classifyNode(source)).toBe("generator");
  });

  it("classifies WebGL feedback filter as feedback", () => {
    const source = readFileSync(
      resolve(EXAMPLE_DIR, "image-feedback-filter-webgl.js"),
      "utf-8"
    );
    expect(classifyNode(source)).toBe("feedback");
  });
});

describe("example node validation", () => {
  it("validates WebGPU filter", () => {
    const source = readFileSync(
      resolve(EXAMPLE_DIR, "image-filter-webgpu.js"),
      "utf-8"
    );
    expect(validateConversion(source).valid).toBe(true);
  });

  it("validates WebGPU generator", () => {
    const source = readFileSync(
      resolve(EXAMPLE_DIR, "image-generator-webgpu.js"),
      "utf-8"
    );
    expect(validateConversion(source).valid).toBe(true);
  });

  it("validates WebGPU feedback filter", () => {
    const source = readFileSync(
      resolve(EXAMPLE_DIR, "image-feedback-filter-webgpu.js"),
      "utf-8"
    );
    expect(validateConversion(source).valid).toBe(true);
  });
});
