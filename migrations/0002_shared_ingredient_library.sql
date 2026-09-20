ALTER TABLE material_profiles ADD COLUMN kind TEXT NOT NULL DEFAULT 'food';
ALTER TABLE material_profiles ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE material_profiles ADD COLUMN supersedes_version TEXT;

CREATE TABLE IF NOT EXISTS material_profile_aliases (
  profile_id TEXT NOT NULL,
  profile_version TEXT NOT NULL,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, profile_version, normalized_alias),
  FOREIGN KEY (profile_id, profile_version)
    REFERENCES material_profiles(id, version) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_material_profiles_active_name
  ON material_profiles(status, name);
CREATE INDEX IF NOT EXISTS idx_material_profile_aliases_lookup
  ON material_profile_aliases(normalized_alias, profile_id, profile_version);
