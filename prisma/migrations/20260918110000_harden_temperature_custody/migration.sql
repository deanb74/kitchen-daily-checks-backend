-- Add database-level validation, completeness, and immutability protections
-- to the existing temperature-custody tables.

ALTER TABLE public."OperationalFact"
    ADD CONSTRAINT "OperationalFact_factType_check" CHECK ("factType" = 'temperature.measurement'),
    ADD CONSTRAINT "OperationalFact_factVersion_check" CHECK ("factVersion" = '1'),
    ADD CONSTRAINT "OperationalFact_subjectType_check" CHECK ("subjectType" = 'equipment'),
    ADD CONSTRAINT "OperationalFact_scopeType_check" CHECK ("scopeType" = 'venue'),
    ADD CONSTRAINT "OperationalFact_sourceKind_check" CHECK ("sourceKind" = 'human'),
    ADD CONSTRAINT "OperationalFact_non_empty_check" CHECK (
        length(btrim("factId")) > 0
        AND length(btrim("subjectId")) > 0
        AND length(btrim("scopeId")) > 0
        AND length(btrim("actorReference")) > 0
        AND length(btrim("provenanceReference")) > 0
    ),
    ADD CONSTRAINT "OperationalFact_timestamp_order_check" CHECK (
        "observedAt" IS NULL OR "observedAt" <= "receivedAt"
    ),
    ADD CONSTRAINT "OperationalFact_payload_shape_check" CHECK (
        jsonb_typeof("payload") = 'object'
        AND "payload" ?& ARRAY['measurementType', 'value', 'unit']
        AND "payload" = jsonb_build_object(
            'measurementType', "payload" -> 'measurementType',
            'value', "payload" -> 'value',
            'unit', "payload" -> 'unit'
        )
        AND "payload" ->> 'measurementType' = 'temperature'
        AND jsonb_typeof("payload" -> 'value') = 'number'
        AND "payload" ->> 'unit' = 'celsius'
    ),
    ADD CONSTRAINT "OperationalFact_relationships_shape_check" CHECK (
        jsonb_typeof("relationships") = 'array'
    );

ALTER TABLE public."FactLegacyTemperatureLogLink"
    ADD CONSTRAINT "FactLegacyTemperatureLogLink_linkMode_check" CHECK (
        "linkMode" IN ('NEW_LEGACY_RECORD', 'LEGACY_FIVE_MINUTE_DUPLICATE_REUSE')
    );

CREATE OR REPLACE FUNCTION public.enforce_operational_fact_custody_complete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  link_count integer;
  receipt_count integer;
BEGIN
  SELECT count(*) INTO link_count
  FROM public."FactLegacyTemperatureLogLink"
  WHERE "factId" = NEW."factId";

  SELECT count(*) INTO receipt_count
  FROM public."FactCustodyReceipt"
  WHERE "factId" = NEW."factId";

  IF link_count <> 1 OR receipt_count <> 1 THEN
    RAISE EXCEPTION 'CUSTODY_COMPLETENESS_VIOLATION: fact % requires exactly one link and receipt', NEW."factId"
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "OperationalFact_custody_complete"
AFTER INSERT ON public."OperationalFact"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.enforce_operational_fact_custody_complete();

CREATE OR REPLACE FUNCTION public.reject_custody_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'CUSTODY_IMMUTABILITY_VIOLATION: % is immutable', TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER "OperationalFact_immutable_rows"
BEFORE UPDATE OR DELETE ON public."OperationalFact"
FOR EACH ROW EXECUTE FUNCTION public.reject_custody_mutation();
CREATE TRIGGER "FactLegacyTemperatureLogLink_immutable_rows"
BEFORE UPDATE OR DELETE ON public."FactLegacyTemperatureLogLink"
FOR EACH ROW EXECUTE FUNCTION public.reject_custody_mutation();
CREATE TRIGGER "FactCustodyReceipt_immutable_rows"
BEFORE UPDATE OR DELETE ON public."FactCustodyReceipt"
FOR EACH ROW EXECUTE FUNCTION public.reject_custody_mutation();
CREATE TRIGGER "OperationalFact_no_truncate"
BEFORE TRUNCATE ON public."OperationalFact"
EXECUTE FUNCTION public.reject_custody_mutation();
CREATE TRIGGER "FactLegacyTemperatureLogLink_no_truncate"
BEFORE TRUNCATE ON public."FactLegacyTemperatureLogLink"
EXECUTE FUNCTION public.reject_custody_mutation();
CREATE TRIGGER "FactCustodyReceipt_no_truncate"
BEFORE TRUNCATE ON public."FactCustodyReceipt"
EXECUTE FUNCTION public.reject_custody_mutation();

REVOKE ALL ON FUNCTION public.reject_custody_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_operational_fact_custody_complete() FROM PUBLIC;

-- ROLLBACK/REVERSAL TEMPLATE (DO NOT EXECUTE AS FORWARD MIGRATION)
-- BEGIN;
-- DROP TRIGGER "OperationalFact_custody_complete" ON public."OperationalFact";
-- DROP TRIGGER "OperationalFact_immutable_rows" ON public."OperationalFact";
-- DROP TRIGGER "OperationalFact_no_truncate" ON public."OperationalFact";
-- DROP TRIGGER "FactLegacyTemperatureLogLink_immutable_rows" ON public."FactLegacyTemperatureLogLink";
-- DROP TRIGGER "FactLegacyTemperatureLogLink_no_truncate" ON public."FactLegacyTemperatureLogLink";
-- DROP TRIGGER "FactCustodyReceipt_immutable_rows" ON public."FactCustodyReceipt";
-- DROP TRIGGER "FactCustodyReceipt_no_truncate" ON public."FactCustodyReceipt";
-- DROP FUNCTION public.enforce_operational_fact_custody_complete();
-- DROP FUNCTION public.reject_custody_mutation();
-- ALTER TABLE public."FactLegacyTemperatureLogLink" DROP CONSTRAINT "FactLegacyTemperatureLogLink_linkMode_check";
-- ALTER TABLE public."OperationalFact" DROP CONSTRAINT "OperationalFact_relationships_shape_check";
-- ALTER TABLE public."OperationalFact" DROP CONSTRAINT "OperationalFact_payload_shape_check";
-- ALTER TABLE public."OperationalFact" DROP CONSTRAINT "OperationalFact_timestamp_order_check";
-- ALTER TABLE public."OperationalFact" DROP CONSTRAINT "OperationalFact_non_empty_check";
-- ALTER TABLE public."OperationalFact" DROP CONSTRAINT "OperationalFact_sourceKind_check";
-- ALTER TABLE public."OperationalFact" DROP CONSTRAINT "OperationalFact_scopeType_check";
-- ALTER TABLE public."OperationalFact" DROP CONSTRAINT "OperationalFact_subjectType_check";
-- ALTER TABLE public."OperationalFact" DROP CONSTRAINT "OperationalFact_factVersion_check";
-- ALTER TABLE public."OperationalFact" DROP CONSTRAINT "OperationalFact_factType_check";
-- COMMIT;
