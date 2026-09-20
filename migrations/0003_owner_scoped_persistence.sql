ALTER TABLE formulas ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE material_profiles ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'legacy';

CREATE INDEX IF NOT EXISTS idx_formulas_owner_created
  ON formulas(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_material_profiles_owner_active
  ON material_profiles(owner_id, status, name);
