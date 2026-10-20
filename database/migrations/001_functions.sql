-- 001 · Functions used by later migrations.
-- Migrations are applied in file-name order by `npm run db:setup` / `npm run migrate` and recorded in
-- schema_migrations. Never edit an applied migration — add a new numbered file instead.

CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
