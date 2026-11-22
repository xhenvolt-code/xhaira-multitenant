BEGIN;

ALTER TABLE public.members
  ADD COLUMN IF NOT EXISTS trashed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trashed_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS trashed_from_status VARCHAR(20);

-- Members exited before the trash workflow existed remain recoverable in Trash.
UPDATE public.members
   SET trashed_at = COALESCE(exit_date::timestamptz, updated_at, NOW()),
       trashed_from_status = COALESCE(trashed_from_status, 'active')
 WHERE status = 'exited' AND trashed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_members_organization_trashed
  ON public.members (organization_id, trashed_at DESC)
  WHERE trashed_at IS NOT NULL;

COMMIT;
