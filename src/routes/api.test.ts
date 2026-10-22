import { describe, it, expect } from "vitest";
import { api, generateTaskId, MAX_BODY_BYTES, MAX_NODES } from "./api";

const webglType = (i: number) => ({
  name: `custom${i}`,
  source: "gl_FragColor = texture2D(u_input_texture, uv);",
});

function upload(body: string) {
  const form = new FormData();
  form.append("file", new File([body], "project.fgmt"));
  return api.request("/migrate-to-webgpu", { method: "POST", body: form }, {});
}

describe("api limits", () => {
  it("rejects uploads over the size limit", async () => {
    const res = await upload("x".repeat(MAX_BODY_BYTES + 1));
    expect(res.status).toBe(413);
  });

  it("rejects files with too many WebGL nodes", async () => {
    const types = Array.from({ length: MAX_NODES + 1 }, (_, i) => webglType(i));
    const res = await upload(JSON.stringify({ types }));
    expect(res.status).toBe(400);
  });
});

describe("task ids", () => {
  it("are random UUIDs", () => {
    expect(generateTaskId()).toMatch(
      /^task_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
