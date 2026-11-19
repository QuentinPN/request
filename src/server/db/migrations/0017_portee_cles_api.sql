-- Portée des clés d'API. Écrite à la main (comme 0013) : une colonne ajoutée par `ALTER TABLE ADD`, sans la
-- reconstruction de table que génère drizzle-kit ; les clés existantes prennent la valeur par défaut, `full`.
ALTER TABLE `api_keys` ADD `scope` text DEFAULT 'full' NOT NULL CONSTRAINT "api_keys_scope_check" CHECK("scope" IN ('read', 'requests', 'full'));
