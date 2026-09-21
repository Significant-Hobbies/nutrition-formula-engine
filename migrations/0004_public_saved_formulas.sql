-- Saved formulas and accepted ingredient profiles are intentionally shared.
-- Keep older profile versions for audit history, but expose only the newest
-- active version for each material after combining the former owner scopes.
UPDATE material_profiles AS profile
SET status = 'inactive'
WHERE status = 'active'
  AND EXISTS (
    SELECT 1
    FROM material_profiles AS newer
    WHERE newer.id = profile.id
      AND newer.status = 'active'
      AND (
        newer.accepted_at > profile.accepted_at
        OR (newer.accepted_at = profile.accepted_at AND newer.version > profile.version)
      )
  );

UPDATE formulas SET owner_id = 'public';
UPDATE material_profiles SET owner_id = 'public';
