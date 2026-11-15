BEGIN;

CREATE INDEX IF NOT EXISTS idx_members_org_active_name_prefix
  ON public.members (organization_id, lower(full_name) text_pattern_ops)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_members_org_active_number_prefix
  ON public.members (organization_id, lower(membership_number) text_pattern_ops)
  WHERE status = 'active' AND membership_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_members_org_active_phone_prefix
  ON public.members (organization_id, lower(phone) text_pattern_ops)
  WHERE status = 'active' AND phone IS NOT NULL;

COMMIT;
