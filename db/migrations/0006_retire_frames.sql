-- H2b (DESIGN §10 #77): retire frame phrases. Data only, expand-safe: rows, cards and review_log
-- stay; a dropped phrase's cards leave scheduling. The `kind` enum keeps 'frame' (contract later).
-- Logs `phrase_retired {phrase_id, reason: 'frame'}` for each, before the update picks them.
INSERT INTO `event` (`id`, `type`, `data`, `at`)
SELECT
	'retired-frame-' || `id`,
	'phrase_retired',
	json_object('phrase_id', `id`, 'reason', 'frame', 'status_before', `status`),
	CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
FROM `phrase`
WHERE `kind` = 'frame' AND `status` <> 'dropped';
--> statement-breakpoint
UPDATE `phrase`
SET
	`status` = 'dropped',
	`dropped_at` = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
	`pinned` = 0,
	`pinned_at` = NULL,
	`updated_at` = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE `kind` = 'frame' AND `status` <> 'dropped';
