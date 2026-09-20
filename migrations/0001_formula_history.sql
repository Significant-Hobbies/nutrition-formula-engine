PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS formulas (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  current_version INTEGER NOT NULL CHECK (current_version > 0),
  access_token_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS formula_versions (
  formula_id TEXT NOT NULL REFERENCES formulas(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  report_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  cause TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL,
  normalized_input_json TEXT NOT NULL,
  decisions_json TEXT NOT NULL,
  profile_refs_json TEXT NOT NULL,
  PRIMARY KEY (formula_id, version)
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  formula_id TEXT NOT NULL,
  formula_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  report_fingerprint TEXT NOT NULL,
  report_json TEXT NOT NULL,
  FOREIGN KEY (formula_id, formula_version)
    REFERENCES formula_versions(formula_id, version) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS identity_decisions (
  id TEXT PRIMARY KEY,
  formula_id TEXT NOT NULL,
  formula_version INTEGER NOT NULL,
  line_index INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('confirm', 'reject', 'replace', 'remove', 'restore')),
  candidate_id TEXT,
  decision_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (formula_id, formula_version)
    REFERENCES formula_versions(formula_id, version) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS material_profiles (
  id TEXT NOT NULL,
  version TEXT NOT NULL,
  name TEXT NOT NULL,
  evidence_kind TEXT NOT NULL,
  source_json TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  profile_fingerprint TEXT NOT NULL,
  retrieved_at TEXT,
  accepted_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
);

CREATE INDEX IF NOT EXISTS idx_formula_versions_created
  ON formula_versions(formula_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_formula_version
  ON reports(formula_id, formula_version);
CREATE INDEX IF NOT EXISTS idx_identity_decisions_formula_version
  ON identity_decisions(formula_id, formula_version, line_index);
CREATE INDEX IF NOT EXISTS idx_material_profiles_name
  ON material_profiles(name);
