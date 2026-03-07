import { Hono } from "hono";
import type { Env, QueueMessage } from "./types";
import { api } from "./routes/api";
import { handleQueue } from "./queue";
import { handleScheduled } from "./cron";
import html from "./frontend/index.html";

const app = new Hono<{ Bindings: Env }>();

app.route("/api", api);

app.get("/", (c) => c.html(html as string));

export default {
  fetch: app.fetch,
  queue: handleQueue,
  scheduled: (_event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(handleScheduled(env));
  },
};
