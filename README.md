# Context

Couche de fusion des apprentissages inférés, pour SilverBackBase.

**Context n'est pas une primitive.** Contrairement à Trail, Mark, Range ou Root, il ne possède
aucune donnée de première main : il agrège ce que d'autres services ont produit et stocke le sens
qui en ressort. C'est une couche transverse, comme le Credit Engine, mais placée au-dessus des
primitives plutôt qu'en dessous. Conception complète : `_conceptions/context/conception.md` dans
le repo `05_SILVERBACKBASE`.

## La frontière avec Root

Root est la mémoire métier **déclarée par un humain** : offres, personas, objections, tarifs,
règles never-do. Context est la connaissance **inférée de la donnée** : comportements observés,
corrélations, effets mesurés d'actions. La différence n'est ni la nature de l'information ni sa
source, c'est qui l'a affirmée. Un item Context se périme mécaniquement et se révise ; un item
Root se corrige, mais ne se périme pas.

## Régime d'écriture : proposer, jamais graver

Aucun agent ne peut créer une affirmation directement dans `items`. Toute affirmation nouvelle ou
contradiction passe par la table `proposals`, en attente de validation humaine (via le site,
`/account/clients/[id]/improve`). Seule une confirmation d'un item déjà validé (`POST
/items/:id/confirm`) écrit directement, et seulement pour incrémenter un compteur, jamais pour
créer du contenu. Cette règle est structurelle dans le code (voir `src/db.ts`, aucune fonction
autre que `acceptProposal` ne fait d'`INSERT INTO items`), pas seulement documentée : la même règle
posée dans la conception d'origine de Root n'avait jamais été appliquée dans le code, ce qui avait
permis d'écrire des patterns sans validation.

## Historique restaurable

Toute mutation de contenu d'un item (création à l'acceptation d'une proposition, mise à jour lors
d'une contradiction acceptée) est journalisée dans `items_history` (append-only, snapshots complets
avant/après, jamais de ligne éditée ou supprimée). `POST /items/:id/revert` restaure l'état
précédent et journalise lui-même un nouvel événement, jamais une réécriture silencieuse. Pattern
répliqué de `knowledge_history` dans le service Root.

## Endpoints

| Route | Rôle |
|---|---|
| `GET /health` | Health check, retourne le `workspace_id` résolu |
| `GET /items` | Liste les items (`project_id?`, `task_type?`) |
| `POST /proposals` | Dépose une affirmation nouvelle ou une contradiction (`contradicts_item_id?`) |
| `GET /proposals` | Liste les propositions (`project_id?`, `status?`) |
| `PATCH /proposals/:id` | Édite une proposition encore `pending` |
| `POST /proposals/:id/accept` | Accepte : écrit dans `items`, journalise l'historique |
| `POST /proposals/:id/reject` | Refuse, n'écrit jamais dans `items` |
| `POST /items/:id/confirm` | Incrémente `observation_count`, promeut `confidence` et rafraîchit `revalidate_at` ; seule écriture directe agent |
| `GET /items/:id/history` | Historique append-only d'un item |
| `POST /items/:id/revert` | Restaure l'état précédent d'un item |
| `GET /logs` | Journal d'activité (`project_id?`, `limit?`) |

Les routes de résolution (`accept`, `reject`, `revert`, `PATCH /proposals/:id`) ne sont **jamais**
exposées comme tool MCP : ce sont des actions strictement humaines, appelées uniquement par le
site via `x-internal-secret`. `context_get`, `context_propose` et `context_confirm` sont les seuls
tools MCP côté passerelle (`silverbackbase-mcp`).

## Isolation

Chaque table porte `workspace_id` (obligatoire) et `project_id`. `project_id` est **obligatoire à
l'écriture** (`POST /proposals` rejette une proposition sans lui) : un item Context naît toujours
de l'analyse d'un client précis, et le laisser optionnel faisait fuiter un item mal taggé vers la
vue globale du workspace, entre les clients d'une même agence. La colonne reste `nullable` dans le
schéma pour les lignes héritées d'avant cette règle. En lecture, `project_id` suit une sémantique
stricte, pas le défaut inclusif de `task_types` : un item au `project_id` `NULL` (résidu hérité) ne
remonte que dans la vue globale du workspace, jamais sous un `project_id` précis. Un workspace
SilverBackBase gère souvent plusieurs clients (une agence), `project_id` est la frontière qui les
isole les uns des autres.

## Fraîcheur

Chaque item porte `revalidate_at`, posé à 30 jours à la création, à une contradiction acceptée, et
repoussé à chaque confirmation. `GET /items` calcule un marqueur `stale` (`revalidate_at` dépassé)
et le renvoie sur chaque item : un item périmé n'est jamais masqué, seulement signalé, pour que
l'agent le traite avec prudence au lieu de le prendre pour une vérité fraîche. La confiance
(`confidence`) progresse `low → medium → high` avec le nombre de confirmations.

## Auth

Fast-path `x-internal-secret` + `x-workspace-id` (service-à-service, gateway et site), actif
seulement si `ENABLE_MCP_AUTH=true` et le secret configuré. Slow-path Bearer, validé via
`{SILVERBACKBASE_URL}/api/tokens/validate` (header `x-trail-secret`, nom historique partagé par
tous les services, pas spécifique à Context). Mode self-hosted (aucun secret configuré) :
`workspace_id = "local"`, tout accepté.

## Variables d'environnement

| Variable | Rôle |
|---|---|
| `DATABASE_URL` | PostgreSQL |
| `PORT` | Port d'écoute (Railway l'injecte, ne pas se fier au défaut du code) |
| `CONTEXT_INTERNAL_SECRET` | Fast-path service-à-service |
| `CONTEXT_VALIDATE_SECRET` | Slow-path Bearer (même valeur que les autres services, voir Auth) |
| `SILVERBACKBASE_URL` | Base pour `/api/tokens/validate` |
| `ENABLE_MCP_AUTH` | `true` en prod cloud, absent en self-hosted |

## Déploiement

Push sur `main` → Railway redéploie automatiquement (service `context`, projet `SilverBackBase`).
Domaine public `context.silverbackbase.com` : CNAME à créer manuellement chez le registrar de la
zone (pas automatisable depuis ce dépôt). La passerelle et le site utilisent le réseau privé
Railway (`context.railway.internal`), pas ce domaine public.

**Ne jamais pousser sur `main` sans validation explicite de Cyril.**
