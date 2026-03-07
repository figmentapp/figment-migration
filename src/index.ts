import { Hono } from "hono";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.text("Figment Migration Service"));

export default {
  fetch: app.fetch,
};
