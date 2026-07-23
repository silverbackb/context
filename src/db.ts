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
// remonte que si le task_type demandé fait partie de ses task_types.
export async function listItemsForWorkspace(workspaceId: string, taskType?: string): Promise<ItemRow[]> {
  const rows = taskType
    ? await sql`
        SELECT * FROM items
        WHERE workspace_id = ${workspaceId}
          AND (task_types IS NULL OR task_types = '{}' OR ${taskType} = ANY(task_types))
        ORDER BY created_at DESC
      `
    : await sql`
        SELECT * FROM items
        WHERE workspace_id = ${workspaceId}
        ORDER BY created_at DESC
      `;
  return rows as unknown as ItemRow[];
}
