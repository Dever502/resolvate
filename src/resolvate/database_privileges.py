"""Protect installation metadata even when tables inherit runtime DML grants."""

# Run both after provisioning existing tables and after migrations create new ones.
# Discover grantees rather than assuming the installation uses fixed role names.
RESTRICT_METADATA_WRITES = """
DO $$
DECLARE target record;
BEGIN
    FOR target IN
        SELECT DISTINCT c.relname, a.grantee
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL aclexplode(c.relacl) a
        WHERE n.nspname = 'public'
          AND c.relname IN ('alembic_version', 'access_audit')
          AND a.grantee <> c.relowner
          AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    LOOP
        EXECUTE format('REVOKE %s ON TABLE public.%I FROM %s',
            CASE WHEN target.relname = 'access_audit' THEN 'UPDATE, DELETE, TRUNCATE'
                 ELSE 'INSERT, UPDATE, DELETE, TRUNCATE' END,
            target.relname,
            CASE WHEN target.grantee = 0 THEN 'PUBLIC'
                 ELSE quote_ident(pg_get_userbyid(target.grantee)) END);
    END LOOP;
END $$;
"""
