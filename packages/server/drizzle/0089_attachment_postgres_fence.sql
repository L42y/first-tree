CREATE OR REPLACE FUNCTION prevent_attachment_payload_externalization()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- A pre-transition Server claims PostgreSQL rows for its PostgreSQL -> S3
  -- backfill by assigning object_key before it clears data. Reject that claim
  -- once a PostgreSQL payload exists so old and new replicas can safely
  -- overlap during the reverse migration.
  IF OLD.data IS NOT NULL AND NEW.object_key IS NOT NULL THEN
    RAISE EXCEPTION 'attachment payload externalization is disabled'
      USING ERRCODE = '23514';
  END IF;

  -- Defense in depth for a row that was already claimed before this migration
  -- installed the trigger. Payload availability is monotonic from this point.
  IF OLD.data IS NOT NULL AND NEW.data IS NULL THEN
    RAISE EXCEPTION 'attachment PostgreSQL payload cannot be cleared'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attachments_prevent_payload_externalization
BEFORE UPDATE OF data, object_key ON attachments
FOR EACH ROW
EXECUTE FUNCTION prevent_attachment_payload_externalization();
