# Member configuration tenant isolation test plan

Run automated validation in an isolated database after applying migrations 956 and 957:

1. Run `npm test` for the pure server-side field validation cases.
2. Set `XHAIRA_TEST_DATABASE_URL` to the isolated PostgreSQL database and run `npm run test:tenant-isolation`. The script uses the runtime database role and only reads data. It verifies a second tenant cannot select the first tenant's member field settings, configuration audit rows, or private document metadata.
3. Create two test organizations with separate administrator sessions. Change one tenant's field labels, required flags, group policies, and document requirements. Verify the other tenant's settings remain unchanged.
4. With tenant A, create two groups and assign an individual. Set membership cardinality to one and verify a second assignment fails; switch it to many and verify it succeeds. Set group requirement to required and verify member registration and loan application reject an ungrouped individual. Set groups disabled and verify registration, group APIs, and the sidebar no longer expose group operations.
5. Attempt to submit tenant A's member ID, group ID, and private document ID under tenant B. Each query must return not found or no rows. Attempt a raw insert of a cross-tenant group/member link using the runtime role; PostgreSQL's reference trigger and RLS must reject it.
6. Upload a PDF and image as tenant A. Confirm the Cloudinary asset type is `authenticated`, its public delivery URL returns an authorization error, and the authorized endpoint issues a short-lived download link. Confirm tenant B receives no metadata or link. Check audit records for upload and each download-link issuance.
7. Turn on a required custom field after members already exist. Confirm existing profiles are marked incomplete and can still be edited; registration and attempts to clear the field on a complete member are rejected by the API.

The automated isolation script does not create fixtures because it must remain safe for any explicit test database URL. The two-tenant mutation scenarios above require a disposable staging database and authenticated tenant sessions.
