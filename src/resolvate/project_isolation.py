"""PostgreSQL project boundary. No context means no access, including raw SQL."""

from sqlalchemy import Connection, text


def install_project_isolation(connection: Connection) -> None:
    connection.execute(
        text("""
        CREATE OR REPLACE FUNCTION public.check_project_reference() RETURNS trigger
        LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
        DECLARE reference text; valid boolean;
        BEGIN
          reference := to_jsonb(NEW)->>TG_ARGV[0];
          IF reference IS NULL THEN RETURN NEW; END IF;
          EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I '
                         'WHERE %I = $1::%s AND project_id = $2)',
                         TG_ARGV[1], TG_ARGV[2], TG_ARGV[3])
                         INTO valid USING reference, NEW.project_id;
          IF NOT valid THEN
            RAISE EXCEPTION 'Invalid project reference' USING ERRCODE = '23503';
          END IF;
          RETURN NEW;
        END $$
    """)
    )
    # Catalog discovery runs in PostgreSQL so offline Alembic SQL has the same protections.
    connection.execute(
        text("""
        DO $isolation$
        DECLARE tbl record; fk record; predicate text;
        BEGIN
          predicate := 'project_id = nullif(current_setting(''resolvate.project_id'', true), '''')';
          FOR tbl IN SELECT table_name FROM information_schema.columns
                     WHERE table_schema = 'public' AND column_name = 'project_id'
                     AND table_name NOT IN ('projects', 'project_members', 'access_audit',
                                            'project_credentials')
          LOOP
            EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl.table_name);
            EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl.table_name);
            EXECUTE format('DROP POLICY IF EXISTS project_boundary ON public.%I', tbl.table_name);
            EXECUTE format('CREATE POLICY project_boundary ON public.%I USING (%s) WITH CHECK (%s)',
                           tbl.table_name, predicate, predicate);
            FOR fk IN
              SELECT a.attname AS col, t.relname AS target, b.attname AS ref,
                     format_type(b.atttypid, b.atttypmod) AS ref_type
              FROM pg_constraint c JOIN pg_class t ON t.oid = c.confrelid
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
              JOIN pg_attribute b ON b.attrelid = c.confrelid AND b.attnum = c.confkey[1]
              WHERE c.contype = 'f' AND c.conrelid = format('public.%I', tbl.table_name)::regclass
                AND t.relname NOT IN ('projects', 'console_accounts', 'console_sessions')
                AND EXISTS (SELECT 1 FROM pg_attribute pa
                            WHERE pa.attrelid = t.oid AND pa.attname = 'project_id')
            LOOP
              EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I',
                             'project_ref_' || fk.col, tbl.table_name);
              EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF %I, project_id '
                             'ON public.%I '
                             'FOR EACH ROW EXECUTE FUNCTION '
                             'public.check_project_reference(%L, %L, %L, %L)',
                             'project_ref_' || fk.col, fk.col, tbl.table_name,
                             fk.col, fk.target, fk.ref, fk.ref_type);
            END LOOP;
          END LOOP;
        END $isolation$
    """)
    )
