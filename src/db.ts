import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required : set it in env vars");

export const sql = postgres(DATABASE_URL, { max: 10 });

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

  console.log(JSON.stringify({ service: "context", event: "migrated", timestamp: new Date().toISOString() }));
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

// ── Item queries ──────────────────────────────────────────────────────────────
//
// Lecture seule pour ce lot (Lot 1, VIS-248). Le régime d'écriture
// (context_propose, file de validation Improve) est le Lot 2 (VIS-249) : les
// items de test de ce lot sont insérés manuellement en SQL par Cyril, pas par
// un tool MCP.

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
