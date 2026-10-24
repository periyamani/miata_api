-- 017 · Module status: how far the teaching of each curriculum module has got.
--
--   modules ─ 1:1 ─ module_statuses   status not_started | in_progress | completed. No row = not started.
--
-- Kept up to date by the professors who teach the module (the course's professors, or the module's own) from their
-- dashboard; admins see it on the course's curriculum. started_at is when the module first went in progress (kept when
-- it is completed), completed_at when it was completed; both are cleared when it goes back to not started.

CREATE TABLE module_statuses (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  module_id     BIGINT      NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'not_started',
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  updated_by    BIGINT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Relationships
ALTER TABLE module_statuses ADD CONSTRAINT fk_module_statuses_module     FOREIGN KEY (module_id)  REFERENCES modules (id) ON DELETE CASCADE;
ALTER TABLE module_statuses ADD CONSTRAINT fk_module_statuses_updated_by FOREIGN KEY (updated_by) REFERENCES users (id)   ON DELETE SET NULL;

-- Constraints
ALTER TABLE module_statuses ADD CONSTRAINT uq_module_statuses_module UNIQUE (module_id);
ALTER TABLE module_statuses ADD CONSTRAINT ck_module_statuses_status CHECK (status IN ('not_started', 'in_progress', 'completed'));
ALTER TABLE module_statuses ADD CONSTRAINT ck_module_statuses_dates CHECK (
  (status = 'not_started' AND started_at IS NULL AND completed_at IS NULL)
  OR (status = 'in_progress' AND started_at IS NOT NULL AND completed_at IS NULL)
  OR (status = 'completed' AND started_at IS NOT NULL AND completed_at >= started_at));

-- Triggers
CREATE TRIGGER module_statuses_updated_at BEFORE UPDATE ON module_statuses FOR EACH ROW EXECUTE FUNCTION set_updated_at();
