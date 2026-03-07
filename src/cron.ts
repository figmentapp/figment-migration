import type { Env } from "./types";

export async function handleScheduled(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT id, input_key, output_key FROM tasks WHERE created_at < datetime('now', '-24 hours')`,
  ).all();

  if (!results || results.length === 0) return;

  for (const task of results) {
    const keysToDelete = [task.input_key as string];
    if (task.output_key) keysToDelete.push(task.output_key as string);
    await Promise.all(keysToDelete.map((key) => env.STORAGE.delete(key)));
  }

  const ids = results.map((t) => t.id as string);
  const placeholders = ids.map(() => "?").join(", ");
  await env.DB.prepare(
    `DELETE FROM tasks WHERE id IN (${placeholders})`,
  )
    .bind(...ids)
    .run();
}
