# Changelog

## 2026-07-24

### Corrigé

Trois mécaniques promises par la conception (§6/§7) existaient dans le schéma mais n'étaient pas
câblées dans le code, et restaient donc inertes.

- **Péremption réactivée.** `revalidate_at` n'était écrit nulle part : le marqueur `stale` de
  `GET /items` valait donc toujours `false`, un item périmé n'était jamais signalé. Il est
  désormais posé (fenêtre de 30 jours par défaut, `REVALIDATE_WINDOW`) à la création d'un item
  (acceptation d'une affirmation nouvelle), à l'acceptation d'une contradiction, et repoussé à
  chaque confirmation.
- **Promotion de confiance.** `confirmItem` incrémentait `observation_count` sans jamais toucher
  `confidence`, rendant l'échelle `medium`/`high` inatteignable. La confiance progresse maintenant
  `low → medium` (dès 2 observations) `→ high` (dès 5), cohérent avec la conception « un insight
  confirmé cinq fois pèse plus qu'un vu une fois ». La réponse de `POST /items/:id/confirm` expose
  désormais `confidence`.
- **`project_id` obligatoire à l'écriture.** `POST /proposals` exige désormais un `project_id` non
  vide. Auparavant optionnel, il pouvait rester `NULL` et l'item mal taggé fuitait alors vers la
  vue globale du workspace, entre les clients d'une même agence. La sémantique de lecture reste
  inchangée (un `NULL` résiduel ne remonte que dans la vue globale) ; c'est l'écriture qui est
  fermée. Rectifie l'entrée « Isolation `project_id` » du 2026-07-23, qui décrivait le champ comme
  simplement « quasi toujours renseigné ».
- **Provenance recalculable durcie.** `metrics` n'exigeait qu'un objet non vide : `{ x: "" }`
  passait comme provenance valide. Chaque valeur doit désormais être un nombre fini, une chaîne non
  vide, ou un booléen. Appliqué à `POST /proposals` et à `PATCH /proposals/:id`.
- **`revertItem`** restaure aussi `last_confirmed_at` et `revalidate_at` depuis le snapshot, pour
  ne pas laisser un item restauré avec une fraîcheur incohérente vis-à-vis de son contenu.

### Vérifié en conditions réelles

Testé le 2026-07-24 sur AT2O (`J4nir3i7QteyLrvSR1HEy`) après déploiement : `context_confirm` a fait
passer un item de `low` à `medium` avec `revalidate_at` posé à J+30 ; `context_propose` sans
`project_id` et avec `metrics` vide sont bien rejetés avant tout débit ; une proposition valide
reste `pending` sans jamais apparaître dans `context_items`.

## 2026-07-23

### Ajouté

**Lot 0 (VIS-247) : fondations cloud.** Service Hono + PostgreSQL, isolation `workspace_id`, auth
fast-path (`x-internal-secret`) + slow-path Bearer, table `items` minimale.

**Lot 1 (VIS-248) : modèle de données et lecture.** Schéma réel d'un item (affirmation, provenance
recalculable : `primitives_read`, fenêtre d'observation, `metrics`, confiance, nombre
d'observations, `task_types`). `GET /items` avec filtrage `task_type` à défaut inclusif et marqueur
`stale` explicite pour un item périmé, jamais masqué en silence. Colonne `project_id` ajoutée en
cours de lot : un workspace SilverBackBase gère souvent plusieurs clients, sans elle les
apprentissages de tous les clients d'un même workspace se seraient mélangés.

**Lot 2 (VIS-249) : régime d'écriture.** Table `proposals` (une affirmation nouvelle ou une
contradiction, jamais une écriture directe dans `items`). `POST /proposals` rejette toute
proposition dont la provenance n'est pas recalculable (primitives lues vides, métriques vides).
`POST /items/:id/confirm` : seule écriture directe agent, limitée à un compteur.

**Lot 3 (VIS-250, backend) : résolution et historique.** `acceptProposal` (transactionnel : la
proposition, l'item et son statut changent ensemble ou pas du tout), `rejectProposal`,
`updateProposal`. Table `items_history` (append-only, snapshots avant/après complets, jamais de
ligne éditée ou supprimée), `revertItem` réplique le pattern `knowledge_history`/`revertItem` de
Root avec une différence délibérée : aucune de ces routes n'est un tool MCP, ce sont des actions
strictement humaines via le site. Table `activity_log` pour le journal Activity.

### Corrigé

- **Isolation `project_id`** : traitement volontairement strict (pas inclusif comme `task_types`).
  Un item sans `project_id` ne remonte que dans la vue globale du workspace, jamais sous un
  `project_id` précis, pour ne pas faire fuiter les apprentissages d'un client vers un autre à
  cause d'un item mal taggé.

### Vérifié en conditions réelles

Testé le 2026-07-23 sur le client AT2O (project_id `J4nir3i7QteyLrvSR1HEy`) : `context_get`
retourne le vrai soul Root, `context_propose` a créé deux propositions réelles fondées sur des
données Trail et Sevya croisées (attribution par canal, écart de comptage entre les deux sources).
A révélé un bug côté passerelle (`silverbackbase-mcp`, voir son propre CHANGELOG), pas dans ce
service.
