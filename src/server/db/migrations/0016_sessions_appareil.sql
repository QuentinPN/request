-- Connexion des clients natifs par jeton Emby (Viewer). Écrite à la main : une colonne nullable ajoutée par
-- `ALTER TABLE ADD`, aucune reconstruction ; les sessions existantes (navigateur) gardent `device_name` à NULL.
ALTER TABLE `sessions` ADD `device_name` text;
