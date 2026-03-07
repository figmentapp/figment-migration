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

  await c.env.STORAGE.put(inputKey, inputData);

  await c.env.DB.prepare(
    `INSERT INTO tasks (id, status, input_type, node_count, nodes_completed, input_key)
     VALUES (?, 'queued', ?, ?, 0, ?)`,
  )
    .bind(taskId, inputType, nodeCount, inputKey)
    .run();

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
