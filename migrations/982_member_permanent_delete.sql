-- Allow the tenant-scoped member deletion API to remove payment intents linked
-- to a member's accounts. Row-level security still limits access to the active
-- organization; the API blocks requests that are pending, processing, or under review.
GRANT DELETE ON public.payment_intents TO xhaira_runtime;
