import { resolve } from "node:path";
import { openDatabase, type Database } from "./database.ts";

/** Query columns over retained relational facts, prepared once per published generation. */
export function finalizeQueryTables(db: Database): void {
	db.exec(`BEGIN IMMEDIATE;
CREATE INDEX IF NOT EXISTS row_rank ON row_data(kind,rank);
UPDATE culture_mark SET review_bits=CASE WHEN review='current' THEN (review_bits & 17) | CASE WHEN state IN ('translated','needs_update','not_synced') THEN ((review_bits & 4) | CASE WHEN (review_bits & 1)=0 THEN 2 ELSE 0 END) ELSE 0 END WHEN review='changed' THEN 8 | CASE WHEN state IN ('translated','needs_update','not_synced') THEN 6 ELSE 0 END ELSE CASE WHEN state IN ('translated','needs_update','not_synced') THEN 6 ELSE 0 END END;
DELETE FROM mark_value WHERE dimension='review';
INSERT INTO mark_value SELECT m.owner,m.culture,'review',lens.name FROM culture_mark m JOIN (SELECT 'reviewed' AS name,1 AS bit UNION ALL SELECT 'not_reviewed',2 UNION ALL SELECT 'not_proofread',4 UNION ALL SELECT 'changed_since_review',8 UNION ALL SELECT 'machine_translated',16) lens ON (m.review_bits & lens.bit)<>0 WHERE m.review IS NOT NULL;
DROP VIEW IF EXISTS query_row;
DROP TABLE IF EXISTS query_flags;
CREATE TABLE query_flags(owner INTEGER PRIMARY KEY,q_origins INTEGER NOT NULL,q_editing INTEGER NOT NULL,q_signals INTEGER NOT NULL,q_notes INTEGER NOT NULL);
INSERT INTO query_flags SELECT r.id,
sum(CASE WHEN f.field='origins' THEN CASE f.value WHEN 'string_table' THEN 1 WHEN 'data_table' THEN 2 WHEN 'asset' THEN 4 WHEN 'cpp' THEN 8 WHEN 'other_source' THEN 16 ELSE 0 END ELSE 0 END),
sum(CASE WHEN f.field='editing' THEN CASE f.value WHEN 'editable' THEN 1 WHEN 'read_only' THEN 2 ELSE 0 END ELSE 0 END),
sum(CASE WHEN f.field='facts' THEN CASE f.value WHEN 'unresolved' THEN 1 WHEN 'conflicting' THEN 2 WHEN 'evidence_only' THEN 4 WHEN 'compiled_copy_differs' THEN 8 ELSE 0 END ELSE 0 END),
CASE WHEN r.kind='line' THEN max(CASE WHEN f.field='notes' AND f.value='present' THEN 1 ELSE 0 END) ELSE coalesce(note.notes,0) END
FROM row_data r LEFT JOIN feature f ON f.owner=r.id AND f.field IN ('origins','editing','facts','notes') LEFT JOIN (SELECT owner,max(notes) AS notes FROM saved_place GROUP BY owner) note ON note.owner=r.id GROUP BY r.id;
CREATE VIEW query_row AS SELECT r.*,q.q_origins,q.q_editing,q.q_signals,q.q_notes FROM row_data r JOIN query_flags q ON q.owner=r.id;
CREATE VIRTUAL TABLE IF NOT EXISTS row_fts USING fts5(source,content='row_data',content_rowid='id',tokenize='trigram case_sensitive 1',detail=none);
INSERT INTO row_fts(row_fts) VALUES ('rebuild');
COMMIT; ANALYZE; PRAGMA wal_checkpoint(TRUNCATE);`);
}
if (process.argv[1]?.replaceAll("\\", "/").endsWith("/full/finalize.ts")) {
	const db = await openDatabase(resolve(process.argv[2]!, "complete.sqlite"), true);
	try {
		finalizeQueryTables(db);
	} finally {
		db.close();
	}
}
