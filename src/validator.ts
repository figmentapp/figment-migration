export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const WEBGL_MARKERS = [
  "gl_FragColor",
  "texture2D(",
  "figment.createShaderProgram(",
  "new figment.Framebuffer(",
  "framebuffer.bind()",
  "figment.drawQuad(",
];

const WEBGPU_PATTERNS = [
  "figment.createImageFilter(",
  "figment.createImageGenerator(",
  "figment.createFeedbackFilter(",
  "figment.generateWgslPreamble(",
];

export function validateConversion(source: string): ValidationResult {
  const errors: string[] = [];

  for (const marker of WEBGL_MARKERS) {
    if (source.includes(marker)) {
      errors.push(`Output still contains WebGL marker: ${marker}`);
    }
  }

  const hasWebGPU = WEBGPU_PATTERNS.some((pattern) =>
    source.includes(pattern)
  );
  if (!hasWebGPU) {
    errors.push(
      "Output must contain figment.createImageFilter, figment.createImageGenerator, figment.createFeedbackFilter, or figment.generateWgslPreamble"
    );
  }

  return { valid: errors.length === 0, errors };
}
