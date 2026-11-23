CREATE TABLE capacity_guard_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  paused boolean NOT NULL DEFAULT false,
  reason text,
  soft_limit_bytes bigint NOT NULL DEFAULT 0,
  resume_limit_bytes bigint NOT NULL DEFAULT 0,
  database_bytes bigint,
  free_bytes bigint,
  checked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
