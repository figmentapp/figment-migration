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
  scheduled: (_event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(handleScheduled(env));
  },
};
