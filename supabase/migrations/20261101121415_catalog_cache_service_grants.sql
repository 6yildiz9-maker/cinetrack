REVOKE ALL ON catalog_items FROM PUBLIC, anon, authenticated;
REVOKE ALL ON derived_profile_cache FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog_items TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON derived_profile_cache TO service_role;
