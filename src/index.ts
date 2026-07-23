import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { readFileSync } from "node:fs";
import {
  migrate,
  listItemsForWorkspace,
  createProposal,
  itemExistsForWorkspace,
  confirmItem,
  logActivity,
  getProposal,
  listProposals,
  updateProposal,
  acceptProposal,
  rejectProposal,
  getItemHistory,
  revertItem,
  listActivityLog,
  ContextError,
} from "./db.js";
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

  const gesture = contradicts_item_id !== undefined ? "contradict" : "new";
  await logActivity(
    workspaceId,
    proposal.project_id,
    "proposal_created",
    `Proposition ${proposal.id} creee (${gesture})`,
    proposal.id
  );

  return c.json({
    proposal_id: proposal.id,
    status: "pending",
    gesture,
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

  await logActivity(
    workspaceId,
    updated.project_id,
    "item_confirmed",
    `Item ${itemId} confirme (observation ${updated.observation_count})`,
    itemId
  );

  return c.json({
    confirmed: true,
    item_id: updated.id,
    observation_count: updated.observation_count,
    last_confirmed_at: updated.last_confirmed_at,
  });
});

// GET /proposals : liste filtrable de la file de propositions (Lot 3,
// VIS-250). Query params `project_id?`, `status?` (pending/accepted/rejected).
// Aucune de ces routes n'est appelable via un tool MCP (conception.md §6) :
// elles ne sont branchees que sur les routes HTTP de ce service, jamais sur
// silverbackbase-mcp.
app.get("/proposals", requireAuth, async (c) => {
  const workspaceId = getWid(c);
  const projectId = c.req.query("project_id") || undefined;
  const status = c.req.query("status") || undefined;
  const proposals = await listProposals(workspaceId, projectId, status);
  return c.json({ proposals });
});

// PATCH /proposals/:id : edite les champs d'une proposition encore 'pending'
// (ex. l'humain corrige l'affirmation avant d'accepter). 409 si la
// proposition est deja resolue.
app.patch("/proposals/:id", requireAuth, async (c) => {
  const workspaceId = getWid(c);
  const proposalId = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(proposalId)) {
    return c.json({ error: "id : identifiant de proposition invalide" }, 400);
  }

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "Body JSON invalide" }, 400);
  }
  const patchBody = body as Record<string, unknown>;
  const { affirmation, primitives_read, metrics } = patchBody;

  if (affirmation !== undefined && (typeof affirmation !== "string" || affirmation.trim().length === 0)) {
    return c.json({ error: "affirmation : chaine non vide requise si fournie" }, 400);
  }
  if (primitives_read !== undefined && (!Array.isArray(primitives_read) || primitives_read.length === 0)) {
    return c.json({ error: "primitives_read : tableau non vide requis si fourni (conception.md §7)" }, 400);
  }
  if (metrics !== undefined && (typeof metrics !== "object" || metrics === null || Array.isArray(metrics) || Object.keys(metrics).length === 0)) {
    return c.json({ error: "metrics : objet non vide requis si fourni (conception.md §7)" }, 400);
  }

  const existing = await getProposal(proposalId, workspaceId);
  if (!existing) {
    return c.json({ error: `Proposition ${proposalId} introuvable pour ce workspace` }, 404);
  }
  if (existing.status !== "pending") {
    return c.json({ error: `Proposition ${proposalId} deja resolue (statut : ${existing.status})` }, 409);
  }

  const updated = await updateProposal(proposalId, workspaceId, {
    affirmation:    affirmation as string | undefined,
    primitivesRead: primitives_read,
    windowStart:    "window_start" in patchBody ? (patchBody.window_start as string | null) : undefined,
    windowEnd:      "window_end" in patchBody ? (patchBody.window_end as string | null) : undefined,
    metrics,
    taskTypes:      "task_types" in patchBody ? (patchBody.task_types as string[] | null) : undefined,
  });

  if (!updated) {
    // Course perdue entre le check ci-dessus et l'UPDATE (proposition resolue entre-temps).
    return c.json({ error: `Proposition ${proposalId} deja resolue` }, 409);
  }

  return c.json({ proposal: updated });
});

// POST /proposals/:id/accept : passe une proposition 'pending' a 'accepted'
// et ecrit dans `items` (creation ou mise a jour selon contradicts_item_id,
// conception.md §6). `overrides` permet a l'humain de corriger l'affirmation
// avant de l'accepter, sans passer par un PATCH separe.
app.post("/proposals/:id/accept", requireAuth, async (c) => {
  const workspaceId = getWid(c);
  const proposalId = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(proposalId)) {
    return c.json({ error: "id : identifiant de proposition invalide" }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const bodyObj = (body ?? {}) as Record<string, unknown>;
  const projectId = typeof bodyObj.project_id === "string" ? bodyObj.project_id : undefined;
  const rawOverrides = bodyObj.overrides && typeof bodyObj.overrides === "object"
    ? bodyObj.overrides as Record<string, unknown>
    : undefined;

  const existing = await getProposal(proposalId, workspaceId);
  if (!existing) {
    return c.json({ error: `Proposition ${proposalId} introuvable pour ce workspace` }, 404);
  }
  if (projectId !== undefined && existing.project_id !== projectId) {
    return c.json({ error: `Proposition ${proposalId} n'appartient pas au projet ${projectId}` }, 404);
  }
  if (existing.status !== "pending") {
    return c.json({ error: `Proposition ${proposalId} deja resolue (statut : ${existing.status})` }, 409);
  }

  const overrides = rawOverrides
    ? {
        affirmation:    typeof rawOverrides.affirmation === "string" ? rawOverrides.affirmation : undefined,
        primitivesRead: rawOverrides.primitives_read,
        windowStart:    "window_start" in rawOverrides ? (rawOverrides.window_start as string | null) : undefined,
        windowEnd:      "window_end" in rawOverrides ? (rawOverrides.window_end as string | null) : undefined,
        metrics:        rawOverrides.metrics,
        taskTypes:      "task_types" in rawOverrides ? (rawOverrides.task_types as string[] | null) : undefined,
      }
    : undefined;

  try {
    const item = await acceptProposal(proposalId, workspaceId, overrides);
    if (!item) {
      // Course perdue entre le check ci-dessus et l'acceptation (proposition resolue entre-temps).
      return c.json({ error: `Proposition ${proposalId} deja resolue` }, 409);
    }
    return c.json({ accepted: true, item });
  } catch (err) {
    if (err instanceof ContextError) {
      const status = err.status === 404 ? 404 : 400;
      return c.json({ error: err.message }, status);
    }
    throw err;
  }
});

// POST /proposals/:id/reject : passe une proposition 'pending' a 'rejected'.
// N'ecrit jamais dans `items`.
app.post("/proposals/:id/reject", requireAuth, async (c) => {
  const workspaceId = getWid(c);
  const proposalId = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(proposalId)) {
    return c.json({ error: "id : identifiant de proposition invalide" }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const bodyObj = (body ?? {}) as Record<string, unknown>;
  const projectId = typeof bodyObj.project_id === "string" ? bodyObj.project_id : undefined;
  const reason = typeof bodyObj.reason === "string" ? bodyObj.reason : undefined;

  const existing = await getProposal(proposalId, workspaceId);
  if (!existing) {
    return c.json({ error: `Proposition ${proposalId} introuvable pour ce workspace` }, 404);
  }
  if (projectId !== undefined && existing.project_id !== projectId) {
    return c.json({ error: `Proposition ${proposalId} n'appartient pas au projet ${projectId}` }, 404);
  }
  if (existing.status !== "pending") {
    return c.json({ error: `Proposition ${proposalId} deja resolue (statut : ${existing.status})` }, 409);
  }

  const rejected = await rejectProposal(proposalId, workspaceId, reason);
  if (!rejected) {
    return c.json({ error: `Proposition ${proposalId} deja resolue` }, 409);
  }

  return c.json({ rejected: true, proposal_id: proposalId });
});

// GET /items/:id/history : historique append-only d'un item, plus recent en
// premier (Lot 3, VIS-250). L'isolation project_id est verifiee via
// itemExistsForWorkspace avant lecture, plutot que de faire porter le filtre
// a getItemHistory : items_history n'a pas a etre interroge deux fois pour
// la meme garantie.
app.get("/items/:id/history", requireAuth, async (c) => {
  const workspaceId = getWid(c);
  const itemId = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(itemId)) {
    return c.json({ error: "id : identifiant d'item invalide" }, 400);
  }
  const projectId = c.req.query("project_id") || undefined;

  const exists = await itemExistsForWorkspace(workspaceId, itemId, projectId);
  if (!exists) {
    return c.json({ error: `Item ${itemId} introuvable pour ce workspace/projet` }, 404);
  }

  const history = await getItemHistory(itemId, workspaceId);
  return c.json({ history });
});

// POST /items/:id/revert : restaure un item a un etat anterieur (conception.md
// §9, "Activity... mutations du contexte avec possibilite de retour arriere").
// Sans `to_history_id`, annule le dernier changement. Avec, restaure l'etat
// produit par cet evenement precis. 400 explicite si aucun historique, ou si
// la cible de restauration est vide (ex. tenter de restaurer le `before` d'un
// evenement 'created').
app.post("/items/:id/revert", requireAuth, async (c) => {
  const workspaceId = getWid(c);
  const itemId = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(itemId)) {
    return c.json({ error: "id : identifiant d'item invalide" }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const bodyObj = (body ?? {}) as Record<string, unknown>;
  const projectId = typeof bodyObj.project_id === "string" ? bodyObj.project_id : undefined;
  const toHistoryId = typeof bodyObj.to_history_id === "number" ? bodyObj.to_history_id : undefined;

  try {
    const item = await revertItem(itemId, workspaceId, projectId, toHistoryId);
    return c.json({ reverted: true, item });
  } catch (err) {
    if (err instanceof ContextError) {
      const status = err.status === 404 ? 404 : 400;
      return c.json({ error: err.message }, status);
    }
    throw err;
  }
});

// GET /logs : journal d'activite unifie, plus recent en premier (conception.md
// §9). Query params `project_id?`, `limit?` (defaut 50). Ne construit aucun
// seuil de significativite ni regroupement anti-friction : une liste simple
// triee par date suffit pour ce lot (voir rapport de tache, c'est un choix
// assume, pas un oubli).
app.get("/logs", requireAuth, async (c) => {
  const workspaceId = getWid(c);
  const projectId = c.req.query("project_id") || undefined;
  const limitParam = c.req.query("limit");
  const parsedLimit = limitParam ? parseInt(limitParam, 10) : 50;
  const limit = Number.isNaN(parsedLimit) ? 50 : parsedLimit;
  const logs = await listActivityLog(workspaceId, projectId, limit);
  return c.json({ logs });
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
