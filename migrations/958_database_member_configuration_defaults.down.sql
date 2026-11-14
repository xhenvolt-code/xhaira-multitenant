BEGIN;

-- Restore the migration 957 seeder contract for rollback. Existing configuration
-- rows are tenant data and are intentionally retained.
CREATE OR REPLACE FUNCTION public.seed_member_configuration_defaults(p_organization_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_organization_id IS NULL OR p_organization_id IS DISTINCT FROM public.current_organization_id() THEN
    RAISE EXCEPTION 'Member defaults can only be seeded for the active organization';
  END IF;
  INSERT INTO public.sacco_configurations
    (organization_id, config_key, config_value, config_type, category, label, description)
  VALUES
    (p_organization_id, 'groups.requirement', '"optional"', 'text', 'members', 'Group requirement', 'Policy for group membership during member registration'),
    (p_organization_id, 'groups.nature', '"member_type"', 'text', 'members', 'Group nature', 'Whether groups are members, sub-organizations, or both'),
    (p_organization_id, 'groups.cardinality', '"one"', 'text', 'members', 'Group membership cardinality', 'Maximum groups linked to each individual')
  ON CONFLICT (organization_id, config_key) DO NOTHING;

  INSERT INTO public.member_field_configs
    (organization_id, field_name, label, section, field_type, is_active, is_required, sort_order, options, validation_rules)
  VALUES
    (p_organization_id, 'first_name', 'First Name', 'personal', 'text', true, true, 1, NULL, '{}'::jsonb),
    (p_organization_id, 'last_name', 'Last Name', 'personal', 'text', true, true, 2, NULL, '{}'::jsonb),
    (p_organization_id, 'other_name', 'Other/Middle Name', 'personal', 'text', true, false, 3, NULL, '{}'::jsonb),
    (p_organization_id, 'gender', 'Gender', 'personal', 'select', true, true, 4, '["male","female","other"]'::jsonb, '{}'::jsonb),
    (p_organization_id, 'date_of_birth', 'Date of Birth', 'personal', 'date', true, true, 5, NULL, '{}'::jsonb),
    (p_organization_id, 'photo_url', 'Profile Photo', 'identification', 'file', false, false, 6, NULL, '{}'::jsonb),
    (p_organization_id, 'national_id', 'National ID Number', 'identification', 'text', true, true, 7, NULL, '{}'::jsonb),
    (p_organization_id, 'id_type', 'ID Type', 'identification', 'select', true, false, 8, '["national_id","passport","other"]'::jsonb, '{}'::jsonb),
    (p_organization_id, 'id_photo_url', 'ID Document Photo', 'identification', 'file', false, false, 9, NULL, '{}'::jsonb),
    (p_organization_id, 'email', 'Email Address', 'contact', 'email', true, false, 10, NULL, '{}'::jsonb),
    (p_organization_id, 'phone', 'Phone Number', 'contact', 'phone', true, true, 11, NULL, '{}'::jsonb),
    (p_organization_id, 'address', 'Home Address', 'contact', 'textarea', true, false, 12, NULL, '{}'::jsonb),
    (p_organization_id, 'occupation', 'Occupation / Job Title', 'employment', 'text', false, false, 13, NULL, '{}'::jsonb),
    (p_organization_id, 'employer', 'Employer / Business Name', 'employment', 'text', false, false, 14, NULL, '{}'::jsonb),
    (p_organization_id, 'monthly_income', 'Monthly Income', 'employment', 'number', false, false, 15, NULL, '{}'::jsonb),
    (p_organization_id, 'next_of_kin_name', 'Next of Kin - Full Name', 'kin', 'text', false, false, 16, NULL, '{}'::jsonb),
    (p_organization_id, 'next_of_kin_phone', 'Next of Kin - Phone', 'kin', 'phone', false, false, 17, NULL, '{}'::jsonb),
    (p_organization_id, 'next_of_kin_relationship', 'Next of Kin - Relationship', 'kin', 'text', false, false, 18, NULL, '{}'::jsonb),
    (p_organization_id, 'emergency_contact_name', 'Emergency Contact - Name', 'kin', 'text', false, false, 19, NULL, '{}'::jsonb),
    (p_organization_id, 'emergency_contact_phone', 'Emergency Contact - Phone', 'kin', 'phone', false, false, 20, NULL, '{}'::jsonb),
    (p_organization_id, 'notes', 'Additional Notes', 'other', 'textarea', false, false, 21, NULL, '{}'::jsonb)
  ON CONFLICT (organization_id, field_name) DO UPDATE SET options = COALESCE(member_field_configs.options, EXCLUDED.options);

  INSERT INTO public.member_document_type_configs
    (organization_id, document_key, label, is_enabled, is_required, accepted_mime_types, max_size_bytes, sort_order)
  VALUES
    (p_organization_id, 'national_id_front', 'National ID front', true, false, '["image/jpeg","image/png","application/pdf"]', 10485760, 1),
    (p_organization_id, 'national_id_back', 'National ID back', true, false, '["image/jpeg","image/png","application/pdf"]', 10485760, 2),
    (p_organization_id, 'introduction_letter', 'Introduction letter', false, false, '["application/pdf","image/jpeg","image/png"]', 10485760, 3)
  ON CONFLICT (organization_id, document_key) DO NOTHING;
END $$;

REVOKE ALL ON FUNCTION public.seed_member_configuration_defaults(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_member_configuration_defaults(UUID) TO xhaira_runtime;

COMMIT;
