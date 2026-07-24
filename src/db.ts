import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required : set it in env vars");

export const sql = postgres(DATABASE_URL, { max: 10 });

// Fenêtre de revalidation par défaut : combien de temps un item reste "frais"
// après sa création, une contradiction acceptée, ou une confirmation, avant
// que /items ne le marque `stale` (conception.md §7). 30 jours est une valeur
// de démarrage arbitraire (aucune donnée historique pour la calibrer à
// l'ouverture de ce lot) : le service ne fixait jusqu'ici jamais revalidate_at
// du tout, ce qui rendait le marqueur `stale` inatteignable en pratique.
const REVALIDATE_WINDOW = sql`NOW() + INTERVAL '30 days'`;

// ── Migration ─────────────────────────────────────────────────────────────────
//
// Lot 1 (VIS-248) : schéma réel d'un item Context, une affirmation adossée à
// une provenance recalculable (conception.md §7). La table `items` existe déjà
// en prod depuis le Lot 0 (VIS-247) avec un schéma minimal (id, workspace_id,
// created_at). La migration est donc additive (ALTER TABLE ... ADD COLUMN IF
// NOT EXISTS, même pattern que root/src/core/db.ts), jamais une recréation qui
// casserait le déploiement existant. Les colonnes NOT NULL portent toutes un
// DEFAULT explicite : depuis PostgreSQL 11, ADD COLUMN avec NOT NULL + DEFAULT
// constant est une opération de métadonnées, elle ne réécrit pas la table et
// ne fait jamais échouer la contrainte sur les lignes déjà présentes.

export async function migrate() {
  await sql`
    CREATE TABLE IF NOT EXISTS items (
      id           SERIAL PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`ALTER TABLE items ADD COLUMN IF NOT EXISTS affirmation TEXT NOT NULL DEFAULT ''`;
  await sql`ALTER TABLE items ADD COLUMN IF NOT EXISTS primitives_read JSONB NOT NULL DEFAULT '[]'::jsonb`;
  await sql`ALTER TABLE items ADD COLUMN IF NOT EXISTS window_start TIMESTAMPTZ`;
  await sql`ALTER TABLE items ADD COLUMN IF NOT EXISTS window_end TIMESTAMPTZ`;
  await sql`ALTER TABLE items ADD COLUMN IF NOT EXISTS metrics JSONB NOT NULL DEFAULT '{}'::jsonb`;
  // confidence : échelle textuelle simple ("low" | "medium" | "high"), pas un
  // score numérique inventé. Le vrai calcul de confiance arrive avec le régime
  // d'écriture du Lot 2 (VIS-249) : observation_count incrémenté à chaque
  // confirmation. Ne pas anticiper de formule ici.
  await sql`ALTER TABLE items ADD COLUMN IF NOT EXISTS confidence TEXT NOT NULL DEFAULT 'low'`;
  await sql`ALTER TABLE items ADD COLUMN IF NOT EXISTS observation_count INTEGER NOT NULL DEFAULT 1`;
  await sql`ALTER TABLE items ADD COLUMN IF NOT EXISTS last_confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`;
  await sql`ALTER TABLE items ADD COLUMN IF NOT EXISTS revalidate_at TIMESTAMPTZ`;
  // NULL/tableau vide = défaut inclusif, l'item remonte toujours (conception.md §7/§8).
  await sql`ALTER TABLE items ADD COLUMN IF NOT EXISTS task_types TEXT[]`;
  // Isolation multi-client au sein d'un même workspace (un workspace SilverBackBase peut gérer
  // plusieurs clients Root, chacun distingué par son project_id). Nullable : voir la note sur
  // listItemsForWorkspace ci-dessous pour la sémantique du filtre.
  await sql`ALTER TABLE items ADD COLUMN IF NOT EXISTS project_id TEXT`;

  // Lot 2 (VIS-249) : table `proposals`, la seule porte d'entrée pour une
  // affirmation nouvelle ou une contradiction (conception.md §6). Aucun tool
  // MCP n'insère jamais directement dans `items` : voir context_propose et
  // context_confirm côté silverbackbase-mcp. `contradicts_item_id` NULL =
  // proposition d'affirmation nouvelle, renseigné = proposition de
  // contradiction sur un item existant. `status` reste à 'pending' dans ce
  // lot : le pipeline qui le fait passer à 'accepted'/'rejected' est le Lot 3
  // (VIS-250), pas implémenté ici.
  await sql`
    CREATE TABLE IF NOT EXISTS proposals (
      id                  SERIAL PRIMARY KEY,
      workspace_id        TEXT NOT NULL DEFAULT 'local',
      project_id          TEXT,
      contradicts_item_id INTEGER,
      affirmation         TEXT NOT NULL,
      primitives_read     JSONB NOT NULL,
      window_start        TIMESTAMPTZ,
      window_end          TIMESTAMPTZ,
      metrics             JSONB NOT NULL,
      task_types          TEXT[],
      status              TEXT NOT NULL DEFAULT 'pending',
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at         TIMESTAMPTZ,
      resolved_by         TEXT
    )
  `;

  // Lot 3 (VIS-250) : historique append-only des mutations d'items, calque
  // fidele sur root/src/core/db.ts (knowledge_history). `before_data`/
  // `after_data` sont des instantanes JSON complets de l'etat de l'item, pas
  // des diffs champ a champ (conception.md, section reference "historique
  // restaurable de Root"). Aucune ligne n'est jamais editee ni supprimee : un
  // revert ajoute lui-meme un nouvel evenement `action = 'reverted'`.
  await sql`
    CREATE TABLE IF NOT EXISTS items_history (
      id           SERIAL PRIMARY KEY,
      item_id      INTEGER NOT NULL,
      workspace_id TEXT NOT NULL,
      project_id   TEXT,
      action       TEXT NOT NULL,
      before_data  JSONB,
      after_data   JSONB,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS items_history_item_id_created_at_idx ON items_history (item_id, created_at DESC)`;

  // Lot 3 (VIS-250) : journal d'activite unifie (conception.md §9, ligne
  // Activity). Regroupe les mutations pertinentes (proposition creee,
  // proposition acceptee/refusee, item confirme, item restaure) pour un
  // futur affichage chronologique. `related_id` pointe selon le cas vers un
  // item ou une proposition, pas de cle etrangere stricte pour rester simple.
  await sql`
    CREATE TABLE IF NOT EXISTS activity_log (
      id           SERIAL PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id   TEXT,
      action       TEXT NOT NULL,
      detail       TEXT,
      related_id   INTEGER,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  console.log(JSON.stringify({ service: "context", event: "migrated", timestamp: new Date().toISOString() }));
}

// Erreur porteuse d'un statut HTTP explicite, pour que la couche route puisse
// distinguer un refus attendu (409 deja resolu, 400 cible de revert vide ou
// absente, 404 introuvable) d'une vraie erreur serveur, sans avoir a
// redupliquer la logique de decision dans index.ts.
export class ContextError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ContextError";
    this.status = status;
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ItemRow {
  id:                number;
  workspace_id:      string;
  affirmation:       string;
  primitives_read:   unknown;
  window_start:      string | null;
  window_end:        string | null;
  metrics:           unknown;
  confidence:        "low" | "medium" | "high";
  observation_count: number;
  last_confirmed_at: string;
  revalidate_at:     string | null;
  task_types:        string[] | null;
  project_id:        string | null;
  created_at:        string;
}

export interface HistoryRow {
  id:           number;
  item_id:      number;
  workspace_id: string;
  project_id:   string | null;
  action:       "created" | "updated" | "reverted";
  before_data:  unknown;
  after_data:   unknown;
  created_at:   string;
}

export interface ActivityLogRow {
  id:           number;
  workspace_id: string;
  project_id:   string | null;
  action:       string;
  detail:       string | null;
  related_id:   number | null;
  created_at:   string;
}

export interface ProposalRow {
  id:                  number;
  workspace_id:        string;
  project_id:          string | null;
  contradicts_item_id: number | null;
  affirmation:         string;
  primitives_read:     unknown;
  window_start:        string | null;
  window_end:          string | null;
  metrics:             unknown;
  task_types:          string[] | null;
  status:              "pending" | "accepted" | "rejected";
  created_at:          string;
  resolved_at:         string | null;
  resolved_by:         string | null;
}

// ── Journalisation (Lot 3, VIS-250) ─────────────────────────────────────────────
//
// logItemHistory et logActivity sont utilisees a la fois par le reste de ce
// fichier (acceptProposal, rejectProposal, revertItem) et par les routes
// existantes deja en prod (POST /proposals, POST /items/:id/confirm), qui se
// contentent d'y ajouter un appel sans changer leur comportement. Les deux
// fonctions acceptent un client SQL optionnel (`client`) pour pouvoir etre
// invoquees depuis l'interieur d'une transaction (sql.begin) quand c'est
// utile, mais restent par defaut sur la connexion globale `sql`.
//
// Non-bloquant par construction, meme philosophie que root/src/core/db.ts
// (commentaire original : "history must never block the primary mutation") :
// un echec d'insertion ici ne doit jamais faire remonter d'erreur a
// l'appelant ni faire echouer la mutation reelle sur `items` ou `proposals`.

export async function logItemHistory(
  itemId: number,
  workspaceId: string,
  projectId: string | null | undefined,
  action: "created" | "updated" | "reverted",
  before: unknown,
  after: unknown,
  client: typeof sql = sql
): Promise<void> {
  try {
    await client`
      INSERT INTO items_history (item_id, workspace_id, project_id, action, before_data, after_data)
      VALUES (
        ${itemId}, ${workspaceId}, ${projectId ?? null}, ${action},
        ${before === null || before === undefined ? null : client.json(before as postgres.JSONValue)},
        ${after === null || after === undefined ? null : client.json(after as postgres.JSONValue)}
      )
    `;
  } catch { /* history must never block the primary mutation */ }
}

export async function logActivity(
  workspaceId: string,
  projectId: string | null | undefined,
  action: string,
  detail: string | null | undefined,
  relatedId: number | null | undefined,
  client: typeof sql = sql
): Promise<void> {
  try {
    await client`
      INSERT INTO activity_log (workspace_id, project_id, action, detail, related_id)
      VALUES (${workspaceId}, ${projectId ?? null}, ${action}, ${detail ?? null}, ${relatedId ?? null})
    `;
  } catch { /* non-blocking, meme philosophie que logItemHistory ci-dessus */ }
}

// ── Item queries ──────────────────────────────────────────────────────────────
//
// listItemsForWorkspace reste en lecture seule (Lot 1, VIS-248). Le régime
// d'écriture des items ne change pas au Lot 2 (VIS-249) : la seule fonction
// qui touche `items` ci-dessous est confirmItem, en UPDATE d'un compteur
// existant. Aucune fonction de ce fichier ne fait d'INSERT INTO items.

// Défaut inclusif (conception.md §7/§8) : un item dont task_types est NULL ou
// vide remonte toujours, quel que soit le task_type demandé. Un item taggé ne
// remonte que si le task_type demandé fait partie de ses task_types. task_types
// est un filtre optionnel de convenance (routage par type de tâche), pas une
// frontière d'isolation : le laisser inclusif par défaut ne fait courir aucun
// risque de fuite de données entre clients.
//
// project_id suit une sémantique STRICTE, délibérément différente : un item
// dont project_id est NULL ne remonte QUE quand aucun projectId n'est demandé
// (vue "tout le workspace"), jamais en filigrane sous un projectId précis.
// Raison : contrairement à task_types, project_id n'est pas un filtre de
// confort mais la frontière d'isolation entre les clients d'un même workspace
// (le problème que cette migration corrige). Un item Context naît forcément de
// l'analyse d'un client précis (conception.md §4 : "affirmation sur le
// comportement du marché ou de la cible d'un client"), donc project_id est
// quasi toujours renseigné à l'écriture. Un project_id NULL est un défaut de
// données (item mal écrit, ou résidu du Lot 0 avant cette colonne), pas une
// déclaration volontaire "vaut pour tous les clients" : le traiter comme
// inclusif referait fuiter les apprentissages d'un client vers tous les
// autres dès qu'un seul item est mal taggé, exactement le risque que la
// consigne demandait d'éliminer.
export async function listItemsForWorkspace(workspaceId: string, taskType?: string, projectId?: string): Promise<ItemRow[]> {
  const taskTypeFilter = taskType
    ? sql`AND (task_types IS NULL OR task_types = '{}' OR ${taskType} = ANY(task_types))`
    : sql``;
  const projectIdFilter = projectId
    ? sql`AND project_id = ${projectId}`
    : sql``;

  const rows = await sql`
    SELECT * FROM items
    WHERE workspace_id = ${workspaceId}
      ${taskTypeFilter}
      ${projectIdFilter}
    ORDER BY created_at DESC
  `;
  return rows as unknown as ItemRow[];
}

// ── Proposal queries (Lot 2, VIS-249) ──────────────────────────────────────────
//
// Seule porte d'entrée pour une affirmation nouvelle ou une contradiction
// (conception.md §6). createProposal et itemExistsForWorkspace restent tels
// quels depuis le Lot 2 : la resolution ('pending' vers 'accepted'/'rejected')
// est ajoutee plus bas dans ce fichier par acceptProposal et rejectProposal
// (Lot 3, VIS-250), pas ici.

// Vérifie qu'un item existe bien pour ce workspace_id ET ce project_id, avant
// d'accepter une proposition de contradiction. Un contradicts_item_id qui ne
// correspond à aucune ligne (mauvais id, mauvais workspace, mauvais projet)
// doit faire échouer l'écriture côté route plutôt que produire une proposition
// orpheline.
export async function itemExistsForWorkspace(workspaceId: string, itemId: number, projectId?: string): Promise<boolean> {
  const projectIdFilter = projectId
    ? sql`AND project_id = ${projectId}`
    : sql``;
  const rows = await sql`
    SELECT id FROM items
    WHERE id = ${itemId}
      AND workspace_id = ${workspaceId}
      ${projectIdFilter}
    LIMIT 1
  `;
  return rows.length > 0;
}

export interface CreateProposalInput {
  workspaceId:        string;
  projectId:          string;
  affirmation:        string;
  primitivesRead:     unknown;
  windowStart?:       string;
  windowEnd?:         string;
  metrics:            unknown;
  taskTypes?:         string[];
  contradictsItemId?: number;
}

// INSERT unique de ce fichier, et volontairement limité à `proposals`. C'est
// la propriété centrale du Lot 2 : une affirmation nouvelle ou une
// contradiction s'écrit ici, jamais dans `items`.
export async function createProposal(input: CreateProposalInput): Promise<ProposalRow> {
  const rows = await sql`
    INSERT INTO proposals (
      workspace_id, project_id, contradicts_item_id, affirmation,
      primitives_read, window_start, window_end, metrics, task_types
    ) VALUES (
      ${input.workspaceId},
      ${input.projectId ?? null},
      ${input.contradictsItemId ?? null},
      ${input.affirmation},
      ${sql.json(input.primitivesRead as postgres.JSONValue)},
      ${input.windowStart ?? null},
      ${input.windowEnd ?? null},
      ${sql.json(input.metrics as postgres.JSONValue)},
      ${input.taskTypes ?? null}
    )
    RETURNING *
  `;
  return rows[0] as unknown as ProposalRow;
}

// ── Confirm (Lot 2, VIS-249) ────────────────────────────────────────────────────
//
// Seule fonction qui écrit dans `items` pour ce lot, et seulement en UPDATE
// d'un compteur sur une ligne déjà existante. Aucune colonne de contenu
// (affirmation, metrics, primitives_read...) n'est modifiée : confirmItem ne
// peut jamais faire naître une affirmation nouvelle, seulement renforcer la
// confiance d'une affirmation déjà validée. Requête atomique en une seule
// instruction (pas de lecture puis écriture séparée) pour éviter toute course
// entre deux confirmations concurrentes. Retourne null si aucune ligne ne
// correspond (item inexistant, ou n'appartenant pas à ce workspace/projet),
// pour que la route sache rejeter avec un 404 explicite plutôt que masquer
// l'échec.
// Seuils de promotion de `confidence` : un insight confirmé plusieurs fois
// pèse plus qu'un vu une fois (conception.md §6). Valeurs de démarrage,
// arbitraires comme REVALIDATE_WINDOW ci-dessus : avant ce correctif,
// confirmItem incrémentait observation_count sans jamais toucher confidence,
// ce qui rendait l'échelle medium/high inatteignable quel que soit le nombre
// de confirmations. `observation_count + 1` (la valeur APRÈS incrément) est
// évalué dans le même SET que l'incrément lui-même : Postgres évalue toutes
// les expressions d'un UPDATE sur la ligne AVANT mutation, donc
// `observation_count + 1` désigne bien la nouvelle valeur ici, pas une
// relecture après écriture.
export async function confirmItem(workspaceId: string, itemId: number, projectId?: string): Promise<ItemRow | null> {
  const projectIdFilter = projectId
    ? sql`AND project_id = ${projectId}`
    : sql``;
  const rows = await sql`
    UPDATE items
    SET observation_count = observation_count + 1,
        confidence = CASE
          WHEN observation_count + 1 >= 5 THEN 'high'
          WHEN observation_count + 1 >= 2 THEN 'medium'
          ELSE 'low'
        END,
        last_confirmed_at = NOW(),
        revalidate_at = ${REVALIDATE_WINDOW}
    WHERE id = ${itemId}
      AND workspace_id = ${workspaceId}
      ${projectIdFilter}
    RETURNING *
  `;
  return (rows[0] as unknown as ItemRow) ?? null;
}

// ── Resolution des propositions (Lot 3, VIS-250) ────────────────────────────────
//
// getProposal, listProposals, updateProposal, acceptProposal, rejectProposal
// font passer une proposition de 'pending' a 'accepted'/'rejected'. Elles
// restent des fonctions de db.ts pures : la decision de qui a le droit de les
// appeler (jamais un tool MCP, uniquement des routes HTTP sur ce service,
// voir index.ts) est portee par la couche route, pas ici.

export async function getProposal(id: number, workspaceId: string): Promise<ProposalRow | null> {
  const rows = await sql`
    SELECT * FROM proposals WHERE id = ${id} AND workspace_id = ${workspaceId} LIMIT 1
  `;
  return (rows[0] as unknown as ProposalRow) ?? null;
}

export async function listProposals(workspaceId: string, projectId?: string, status?: string): Promise<ProposalRow[]> {
  const projectIdFilter = projectId ? sql`AND project_id = ${projectId}` : sql``;
  const statusFilter    = status ? sql`AND status = ${status}` : sql``;
  const rows = await sql`
    SELECT * FROM proposals
    WHERE workspace_id = ${workspaceId}
      ${projectIdFilter}
      ${statusFilter}
    ORDER BY created_at DESC
  `;
  return rows as unknown as ProposalRow[];
}

export interface UpdateProposalPatch {
  affirmation?:    string;
  primitivesRead?: unknown;
  windowStart?:    string | null;
  windowEnd?:      string | null;
  metrics?:        unknown;
  taskTypes?:      string[] | null;
}

// Edite les champs d'une proposition encore 'pending'. Refuse (retourne null)
// si la proposition n'existe pas ou n'est plus 'pending' : la route sait alors
// repondre 409 (deja resolue) sans avoir a rejouer la logique de decision.
// Le filtre `status = 'pending'` est dans la clause WHERE de l'UPDATE lui-meme
// (pas verifie a part dans une lecture prealable) pour rester atomique face a
// une resolution concurrente de la meme proposition.
export async function updateProposal(id: number, workspaceId: string, patch: UpdateProposalPatch): Promise<ProposalRow | null> {
  const current = await getProposal(id, workspaceId);
  if (!current) return null;

  const affirmation    = patch.affirmation ?? current.affirmation;
  const primitivesRead = patch.primitivesRead ?? current.primitives_read;
  const windowStart    = patch.windowStart !== undefined ? patch.windowStart : current.window_start;
  const windowEnd      = patch.windowEnd !== undefined ? patch.windowEnd : current.window_end;
  const metrics        = patch.metrics ?? current.metrics;
  const taskTypes      = patch.taskTypes !== undefined ? patch.taskTypes : current.task_types;

  const rows = await sql`
    UPDATE proposals SET
      affirmation     = ${affirmation},
      primitives_read = ${sql.json(primitivesRead as postgres.JSONValue)},
      window_start    = ${windowStart},
      window_end      = ${windowEnd},
      metrics         = ${sql.json(metrics as postgres.JSONValue)},
      task_types      = ${taskTypes}
    WHERE id = ${id} AND workspace_id = ${workspaceId} AND status = 'pending'
    RETURNING *
  `;
  return (rows[0] as unknown as ProposalRow) ?? null;
}

export interface AcceptProposalOverrides {
  affirmation?:    string;
  primitivesRead?: unknown;
  windowStart?:    string | null;
  windowEnd?:      string | null;
  metrics?:        unknown;
  taskTypes?:      string[] | null;
}

// Coeur transactionnel de l'acceptation (conception.md §6, geste "affirmation
// nouvelle" ou "contradiction"). La lecture de la proposition (FOR UPDATE),
// l'ecriture sur `items` (INSERT si affirmation nouvelle, UPDATE si
// contradiction) et le passage de la proposition a 'accepted' doivent reussir
// ou echouer ensemble : sql.begin garantit qu'aucune proposition ne passe a
// 'accepted' sans que l'item correspondant existe reellement, et inversement.
//
// La journalisation (logItemHistory, logActivity) est volontairement laissee
// EN DEHORS de cette transaction, sur la connexion globale `sql` plutot que
// sur `tx` : une commande qui echoue a l'interieur d'une transaction Postgres
// invalide tout le bloc jusqu'au ROLLBACK, meme si l'exception JS est
// rattrapee par le try/catch interne a logItemHistory/logActivity. Les
// executer apres la transaction, une fois qu'elle a commit, preserve la
// garantie "l'echec de la journalisation ne bloque jamais la mutation
// principale" sans jamais risquer d'invalider cette mutation elle-meme.
export async function acceptProposal(
  id: number,
  workspaceId: string,
  overrides?: AcceptProposalOverrides
): Promise<ItemRow | null> {
  type TxResult = {
    item:          ItemRow;
    before:        ItemRow | null;
    historyAction: "created" | "updated";
    proposalId:    number;
  } | null;

  const result: TxResult = await sql.begin(async (tx) => {
    const proposalRows = await tx`
      SELECT * FROM proposals WHERE id = ${id} AND workspace_id = ${workspaceId} FOR UPDATE
    `;
    const proposal = (proposalRows[0] as unknown as ProposalRow) ?? null;
    if (!proposal || proposal.status !== "pending") return null;

    const affirmation    = overrides?.affirmation ?? proposal.affirmation;
    const primitivesRead = overrides?.primitivesRead ?? proposal.primitives_read;
    const windowStart    = overrides?.windowStart !== undefined ? overrides.windowStart : proposal.window_start;
    const windowEnd      = overrides?.windowEnd !== undefined ? overrides.windowEnd : proposal.window_end;
    const metrics        = overrides?.metrics ?? proposal.metrics;
    const taskTypes      = overrides?.taskTypes !== undefined ? overrides.taskTypes : proposal.task_types;

    let item: ItemRow;
    let before: ItemRow | null;
    let historyAction: "created" | "updated";

    if (proposal.contradicts_item_id === null) {
      // Affirmation nouvelle : confidence 'low', observation_count 1, comme
      // toute affirmation qui vient d'entrer dans le systeme (conception.md §6).
      const rows = await tx`
        INSERT INTO items (
          workspace_id, project_id, affirmation, primitives_read,
          window_start, window_end, metrics, confidence, observation_count,
          last_confirmed_at, revalidate_at, task_types
        ) VALUES (
          ${workspaceId}, ${proposal.project_id}, ${affirmation},
          ${tx.json(primitivesRead as postgres.JSONValue)},
          ${windowStart}, ${windowEnd},
          ${tx.json(metrics as postgres.JSONValue)},
          'low', 1, NOW(), ${REVALIDATE_WINDOW}, ${taskTypes}
        )
        RETURNING *
      `;
      item = rows[0] as unknown as ItemRow;
      before = null;
      historyAction = "created";
    } else {
      const beforeRows = await tx`
        SELECT * FROM items WHERE id = ${proposal.contradicts_item_id} AND workspace_id = ${workspaceId}
      `;
      before = (beforeRows[0] as unknown as ItemRow) ?? null;
      if (!before) {
        throw new ContextError(
          `Item ${proposal.contradicts_item_id} introuvable pour accepter la contradiction de la proposition ${id}`,
          400
        );
      }

      // Contradiction : la confiance repart de zero, coherent avec confirmItem
      // qui lui la fait progresser (conception.md §6). C'est une affirmation
      // qui vient de changer, pas une confirmation de l'ancienne.
      const rows = await tx`
        UPDATE items SET
          affirmation       = ${affirmation},
          primitives_read   = ${tx.json(primitivesRead as postgres.JSONValue)},
          window_start      = ${windowStart},
          window_end        = ${windowEnd},
          metrics           = ${tx.json(metrics as postgres.JSONValue)},
          confidence        = 'low',
          observation_count = 1,
          last_confirmed_at = NOW(),
          revalidate_at     = ${REVALIDATE_WINDOW},
          task_types        = ${taskTypes}
        WHERE id = ${proposal.contradicts_item_id} AND workspace_id = ${workspaceId}
        RETURNING *
      `;
      item = rows[0] as unknown as ItemRow;
      historyAction = "updated";
    }

    await tx`
      UPDATE proposals SET status = 'accepted', resolved_at = NOW()
      WHERE id = ${id} AND workspace_id = ${workspaceId}
    `;

    return { item, before, historyAction, proposalId: proposal.id };
  });

  if (!result) return null;

  const { item, before, historyAction, proposalId } = result;
  await logItemHistory(item.id, workspaceId, item.project_id, historyAction, before, item);
  await logActivity(workspaceId, item.project_id, "proposal_accepted", `Proposition ${proposalId} acceptee, item ${item.id}`, item.id);

  return item;
}

// Refuse une proposition encore 'pending'. Retourne null si elle n'existe pas
// ou n'est plus 'pending' (route : 409). N'ecrit jamais dans `items`.
export async function rejectProposal(id: number, workspaceId: string, reason?: string): Promise<ProposalRow | null> {
  const rows = await sql`
    UPDATE proposals SET status = 'rejected', resolved_at = NOW()
    WHERE id = ${id} AND workspace_id = ${workspaceId} AND status = 'pending'
    RETURNING *
  `;
  const proposal = (rows[0] as unknown as ProposalRow) ?? null;
  if (proposal) {
    await logActivity(workspaceId, proposal.project_id, "proposal_rejected", reason ?? null, proposal.id);
  }
  return proposal;
}

// Non explicitement nommee dans le brief, mais necessaire a la route GET
// /logs qu'il demande : lecture simple, triee par date decroissante, du
// journal d'activite unifie (conception.md §9). Meme semantique stricte de
// project_id que listItemsForWorkspace/listProposals (filtre d'isolation,
// pas de defaut inclusif).
export async function listActivityLog(workspaceId: string, projectId?: string, limit = 50): Promise<ActivityLogRow[]> {
  const projectIdFilter = projectId ? sql`AND project_id = ${projectId}` : sql``;
  const rows = await sql`
    SELECT * FROM activity_log
    WHERE workspace_id = ${workspaceId}
      ${projectIdFilter}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows as unknown as ActivityLogRow[];
}

// ── Historique et revert d'items (Lot 3, VIS-250) ───────────────────────────────

export async function getItemHistory(itemId: number, workspaceId: string, limit = 50): Promise<HistoryRow[]> {
  const rows = await sql`
    SELECT * FROM items_history
    WHERE item_id = ${itemId} AND workspace_id = ${workspaceId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows as unknown as HistoryRow[];
}

// Replique fidele du pattern Root (root/src/core/knowledge.ts, revertItem) :
// sans `toHistoryId`, restaure le `before_data` du tout dernier evenement
// (annule le dernier changement) ; avec, restaure le `after_data` de cet
// evenement precis. Ne modifie ni ne supprime jamais une ligne d'historique
// existante (append-only) : le revert lui-meme est journalise comme un
// nouvel evenement `action = 'reverted'`.
//
// Seules les colonnes couvertes par acceptProposal sont restaurees
// (affirmation, primitives_read, window_start/end, metrics, confidence,
// observation_count, task_types) : project_id, workspace_id et created_at ne
// bougent jamais par ce chemin, et confidence/observation_count sont repris
// tels quels depuis l'instantane restaure, jamais recalcules ici.
export async function revertItem(
  itemId: number,
  workspaceId: string,
  projectId?: string,
  toHistoryId?: number
): Promise<ItemRow> {
  const projectIdFilter = projectId ? sql`AND project_id = ${projectId}` : sql``;
  const currentRows = await sql`
    SELECT * FROM items WHERE id = ${itemId} AND workspace_id = ${workspaceId} ${projectIdFilter}
  `;
  const current = (currentRows[0] as unknown as ItemRow) ?? null;
  if (!current) {
    throw new ContextError(`Item ${itemId} introuvable pour ce workspace/projet`, 404);
  }

  const history = await getItemHistory(itemId, workspaceId, 1000);
  if (history.length === 0) {
    throw new ContextError(`Aucun historique trouve pour l'item ${itemId}, rien a annuler`, 400);
  }

  let restored: Record<string, unknown> | null;
  if (toHistoryId !== undefined) {
    const event = history.find((e) => e.id === toHistoryId);
    if (!event) {
      throw new ContextError(`Evenement d'historique ${toHistoryId} introuvable pour l'item ${itemId}`, 400);
    }
    restored = event.after_data as Record<string, unknown> | null;
  } else {
    restored = history[0].before_data as Record<string, unknown> | null;
  }

  if (!restored) {
    throw new ContextError(
      `Cible de restauration vide pour l'item ${itemId} : Context ne supprime jamais un item par ce chemin`,
      400
    );
  }

  const updatedRows = await sql`
    UPDATE items SET
      affirmation       = ${restored.affirmation as string},
      primitives_read   = ${sql.json(restored.primitives_read as postgres.JSONValue)},
      window_start      = ${(restored.window_start as string | null) ?? null},
      window_end        = ${(restored.window_end as string | null) ?? null},
      metrics           = ${sql.json(restored.metrics as postgres.JSONValue)},
      confidence        = ${restored.confidence as string},
      observation_count = ${restored.observation_count as number},
      last_confirmed_at = ${(restored.last_confirmed_at as string | null) ?? null},
      revalidate_at     = ${(restored.revalidate_at as string | null) ?? null},
      task_types        = ${(restored.task_types as string[] | null) ?? null}
    WHERE id = ${itemId} AND workspace_id = ${workspaceId}
    RETURNING *
  `;
  const updated = updatedRows[0] as unknown as ItemRow;

  await logItemHistory(itemId, workspaceId, updated.project_id, "reverted", current, updated);
  await logActivity(workspaceId, updated.project_id, "item_reverted", `Item ${itemId} restaure`, itemId);

  return updated;
}
