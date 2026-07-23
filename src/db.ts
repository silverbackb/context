import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required : set it in env vars");

export const sql = postgres(DATABASE_URL, { max: 10 });

// ── Migration ─────────────────────────────────────────────────────────────────
//
// Lot 0 (VIS-247) : table minimale, juste assez pour prouver que l'isolation
// workspace_id fonctionne de bout en bout. Le schéma final (affirmation,
// provenance recalculable, confiance, observations, revalidation : voir
// _conceptions/context/conception.md §7) est le Lot 1, pas ce lot. Ne pas
// ajouter de colonnes métier ici.

export async function migrate() {
  await sql`
    CREATE TABLE IF NOT EXISTS items (
      id           SERIAL PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  console.log(JSON.stringify({ service: "context", event: "migrated", timestamp: new Date().toISOString() }));
}

// ── Item queries (scaffolding Lot 0, non exposées en HTTP pour l'instant) ─────
//
// Ces fonctions existent pour prouver, au niveau du code, que chaque accès à
// `items` filtre par workspace_id (règle d'isolation non négociable, pattern
// Root v0.4.3). Elles ne sont pas encore branchées sur une route HTTP : aucun
// tool MCP de ce lot n'en a besoin (context_ping n'appelle que GET /health).

export async function insertItem(workspaceId: string): Promise<number> {
  const rows = await sql`
    INSERT INTO items (workspace_id)
    VALUES (${workspaceId})
    RETURNING id
  `;
  return Number(rows[0].id);
}

export async function listItems(workspaceId: string) {
  return sql`
    SELECT * FROM items
    WHERE workspace_id = ${workspaceId}
    ORDER BY created_at DESC
  `;
}
