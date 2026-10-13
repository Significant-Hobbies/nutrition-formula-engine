-- Local/review migration only. Do not apply remotely without separate authorization.
CREATE TABLE line_review_decisions (
 owner_id TEXT NOT NULL,
 formula_id TEXT NOT NULL,
 source_row_id TEXT NOT NULL,
 request_id TEXT NOT NULL,
 payload_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 UNIQUE(owner_id, formula_id, request_id),
 FOREIGN KEY(formula_id) REFERENCES formulas(id)
);
CREATE INDEX line_review_readback ON line_review_decisions(owner_id, formula_id, sequence);
