import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { readFileSync } from "node:fs";
import { migrate, listItemsForWorkspace, createProposal, itemExistsForWorkspace, confirmItem } from "./db.js";
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
// Filtre optionnel `project_id`, sémantique stricte (voir commentaire de
// listItemsForWorkspace dans db.ts) : isole les apprentissages d'un client
// des autres clients du même workspace.
// Aucun item pour ce workspace → `{ items: [] }`, jamais une erreur.
app.get("/items", requireAuth, async (c) => {
  const workspaceId = getWid(c);
  const taskType = c.req.query("task_type") || undefined;
  const projectId = c.req.query("project_id") || undefined;
  const rows = await listItemsForWorkspace(workspaceId, taskType, projectId);
  const now = Date.now();
  const items = rows.map((row) => ({
    ...row,
    stale: row.revalidate_at ? new Date(row.revalidate_at).getTime() < now : false,
  }));
  return c.json({ items });
});

// POST /proposals : seule route qui accepte une affirmation nouvelle ou une
// contradiction (Lot 2, VIS-249, conception.md §6). Écrit exclusivement dans
// `proposals`, jamais dans `items` : aucune affirmation ne devient une vérité
// tant qu'un humain ou le pipeline Improve (Lot 3, VIS-250, pas fait ici) ne
// l'a pas validée.
//
// Provenance recalculable minimale (conception.md §7) : `affirmation` non
// vide, `primitives_read` tableau non vide, `metrics` objet non vide. Une
// proposition qui ne porte pas ce minimum est refusée à l'écriture (400),
// avant même d'atteindre la file de validation.
app.post("/proposals", requireAuth, async (c) => {
  const workspaceId = getWid(c);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "Body JSON invalide" }, 400);
  }

  const { project_id, affirmation, primitives_read, window_start, window_end, metrics, task_types, contradicts_item_id } = body as Record<string, unknown>;

  if (typeof affirmation !== "string" || affirmation.trim().length === 0) {
    return c.json({ error: "affirmation : chaîne non vide requise" }, 400);
  }
  if (!Array.isArray(primitives_read) || primitives_read.length === 0) {
    return c.json({ error: "primitives_read : tableau non vide requis (provenance recalculable, conception.md §7)" }, 400);
  }
  if (typeof metrics !== "object" || metrics === null || Array.isArray(metrics) || Object.keys(metrics).length === 0) {
    return c.json({ error: "metrics : objet non vide requis (provenance recalculable, conception.md §7)" }, 400);
  }
  if (project_id !== undefined && typeof project_id !== "string") {
    return c.json({ error: "project_id : chaîne attendue" }, 400);
  }
  if (contradicts_item_id !== undefined && typeof contradicts_item_id !== "number") {
    return c.json({ error: "contradicts_item_id : nombre attendu" }, 400);
  }

  if (contradicts_item_id !== undefined) {
    const exists = await itemExistsForWorkspace(workspaceId, contradicts_item_id, project_id as string | undefined);
    if (!exists) {
      return c.json({ error: `contradicts_item_id ${contradicts_item_id} : aucun item trouvé pour ce workspace/projet` }, 400);
    }
  }

  const proposal = await createProposal({
    workspaceId,
    projectId: project_id as string | undefined,
    affirmation,
    primitivesRead: primitives_read,
    windowStart: window_start as string | undefined,
    windowEnd: window_end as string | undefined,
    metrics,
    taskTypes: task_types as string[] | undefined,
    contradictsItemId: contradicts_item_id as number | undefined,
  });

  return c.json({
    proposal_id: proposal.id,
    status: "pending",
    gesture: contradicts_item_id !== undefined ? "contradict" : "new",
  });
});

// POST /items/:id/confirm : seul chemin d'écriture directe dans `items`
// (Lot 2, VIS-249, conception.md §6). N'ajoute aucune affirmation nouvelle :
// incrémente `observation_count` et rafraîchit `last_confirmed_at` sur une
// ligne déjà existante. 404 explicite si l'item n'existe pas, ou n'appartient
// pas à ce workspace/projet, plutôt qu'un échec silencieux.
app.post("/items/:id/confirm", requireAuth, async (c) => {
  const workspaceId = getWid(c);
  const itemId = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(itemId)) {
    return c.json({ error: "id : identifiant d'item invalide" }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const projectId = typeof (body as Record<string, unknown>)?.project_id === "string"
    ? (body as Record<string, unknown>).project_id as string
    : undefined;

  const updated = await confirmItem(workspaceId, itemId, projectId);
  if (!updated) {
    return c.json({ error: `Item ${itemId} introuvable pour ce workspace/projet` }, 404);
  }

  return c.json({
    confirmed: true,
    item_id: updated.id,
    observation_count: updated.observation_count,
    last_confirmed_at: updated.last_confirmed_at,
  });
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
