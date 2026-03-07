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
          JSON.stringify([{ error: err instanceof Error ? err.message : String(err) }]),
          taskId,
        )
        .run();

      message.ack();
    }
  }
}

async function processTask(taskId: string, env: Env): Promise<void> {
  await env.DB.prepare(
    `UPDATE tasks SET status = 'processing', updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(taskId)
    .run();

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

async function processSourceCode(taskId: string, inputData: string, env: Env): Promise<void> {
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

async function processFgmtFile(taskId: string, inputData: string, env: Env): Promise<void> {
  const fgmt: FgmtFile = JSON.parse(inputData);
  const errors: ConversionResult[] = [];
  let nodesCompleted = 0;

  for (const type of fgmt.types) {
    if (!hasWebGLMarkers(type.source)) {
      continue;
    }

    const classification = classifyNode(type.source);
    const result = await convertNode(env.ANTHROPIC_API_KEY, classification, type.source);

    if (result.success) {
      type.source = result.output!;
      nodesCompleted++;
    } else {
      type.source = `// MIGRATION FAILED: ${result.error}\n// Original WebGL code preserved.\n${type.source}`;
      errors.push({ typeName: type.name, success: false, error: result.error });
    }

    await env.DB.prepare(
      `UPDATE tasks SET nodes_completed = ?, updated_at = datetime('now') WHERE id = ?`,
    )
      .bind(nodesCompleted, taskId)
      .run();
  }

  fgmt.version = 6;

  const outputKey = `outputs/${taskId}.json`;
  await env.STORAGE.put(outputKey, JSON.stringify(fgmt, null, 2));

  const status = errors.length === 0 ? "completed" : nodesCompleted > 0 ? "partial" : "failed";

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
