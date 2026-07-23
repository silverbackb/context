import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { readFileSync } from "node:fs";
import { migrate, listItemsForWorkspace } from "./db.js";
import { requireAuth } from "./auth.js";

let SERVICE_VERSION = "0.0.0";
try { SERVICE_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")).version; } catch {}

function getWid(c: any): string {
  return (c.get as (k: string) => string | null)("workspaceId") ?? "local";
}

// ── App ───────────────────────────────────────────────────────────────────────

const app = new Hono();

app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "DELETE", "OPTIONS"] }));

app.use("*", async (c, next) => {
  const start   = Date.now();
  const traceId = c.req.header("x-trace-id") ?? "local";
  await next();
  process.stdout.write(JSON.stringify({
    service:     "context",
    trace_id:    traceId,
    method:      c.req.method,
    path:        new URL(c.req.url).pathname,
    status:      c.res.status,
    duration_ms: Date.now() - start,
    timestamp:   new Date().toISOString(),
  }) + "\n");
});

// GET /health : endpoint de validation initialement posé au Lot 0 (VIS-247).
// Placé derrière requireAuth pour que le workspace_id retourné dans la réponse
// prouve que la passerelle a bien résolu et transmis le bon workspace_id
// jusqu'au service.
app.get("/health", requireAuth, (c) => {
  const workspaceId = getWid(c);
  return c.json({ status: "ok", service: "context", version: SERVICE_VERSION, workspace_id: workspaceId });
});

app.get("/version", (c) => c.json({ package: "@silverbackbase/context", version: SERVICE_VERSION }));

// GET /items : lecture des items Context du workspace (Lot 1, VIS-248).
// Filtre optionnel `task_type` en query param, défaut inclusif (conception.md
// §7/§8) : un item non tagué remonte toujours. Un item périmé n'est jamais
// masqué, il est renvoyé avec un marqueur `stale` explicite (conception.md
// §7 : "renvoyé avec un marqueur explicite", jamais silencieusement filtré).
// Aucun item pour ce workspace → `{ items: [] }`, jamais une erreur.
app.get("/items", requireAuth, async (c) => {
  const workspaceId = getWid(c);
  const taskType = c.req.query("task_type") || undefined;
  const rows = await listItemsForWorkspace(workspaceId, taskType);
  const now = Date.now();
  const items = rows.map((row) => ({
    ...row,
    stale: row.revalidate_at ? new Date(row.revalidate_at).getTime() < now : false,
  }));
  return c.json({ items });
});

// ── Boot ──────────────────────────────────────────────────────────────────────

const port = parseInt(process.env.PORT ?? "3000", 10);

await migrate();

serve({ fetch: app.fetch, port, hostname: "::" }, () => {
  console.log(JSON.stringify({
    service:   "context",
    event:     "started",
    port,
    timestamp: new Date().toISOString(),
  }));
});
