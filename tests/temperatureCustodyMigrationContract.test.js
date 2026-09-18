import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "..");
const schema = fs.readFileSync(path.join(repositoryRoot, "prisma", "schema.prisma"), "utf8");
const migrationPath = path.join(
  repositoryRoot,
  "prisma",
  "migrations",
  "20260918110000_harden_temperature_custody",
  "migration.sql",
);
const migration = fs.readFileSync(migrationPath, "utf8");
const rollbackStart = migration.indexOf("-- ROLLBACK/REVERSAL TEMPLATE");
const forward = migration.slice(0, rollbackStart);
const rollback = migration.slice(rollbackStart);

const expectAll = (value, fragments) => {
  for (const fragment of fragments) assert.match(value, fragment);
};

test("contains the exact Prisma custody models and inverse relation", () => {
  expectAll(schema, [
    /model TemperatureLog \{/, /custodyLinks\s+FactLegacyTemperatureLogLink\[\].*@relation\("TemperatureLogCustodyLinks"\)/,
    /model OperationalFact \{/, /model FactLegacyTemperatureLogLink \{/, /model FactCustodyReceipt \{/,
    /@map\("OperationalFact"\)/, /@map\("FactLegacyTemperatureLogLink"\)/, /@map\("FactCustodyReceipt"\)/,
    /@unique\(map: "FactLegacyTemperatureLogLink_factId_key"\)/,
    /@unique\(map: "FactCustodyReceipt_factId_key"\)/,
    /@unique\(map: "FactCustodyReceipt_persistenceId_key"\)/,
    /@unique\(map: "FactCustodyReceipt_persistenceReference_key"\)/,
    /onDelete: Restrict, onUpdate: Restrict/,
  ]);
});

test("contains schema-qualified additive custody hardening", () => {
  expectAll(migration, [
    /ALTER TABLE public\."OperationalFact"/,
    /ALTER TABLE public\."FactLegacyTemperatureLogLink"/,
    /ADD CONSTRAINT "OperationalFact_payload_shape_check"/,
    /ADD CONSTRAINT "FactLegacyTemperatureLogLink_linkMode_check"/,
    /CREATE CONSTRAINT TRIGGER "OperationalFact_custody_complete"/,
    /DEFERRABLE INITIALLY DEFERRED/,
    /SET search_path = pg_catalog/,
    /REVOKE ALL ON FUNCTION public\.reject_custody_mutation\(\) FROM PUBLIC/,
    /REVOKE ALL ON FUNCTION public\.enforce_operational_fact_custody_complete\(\) FROM PUBLIC/,
  ]);
});

test("contains deferred completeness and immutability protections", () => {
  expectAll(migration, [
    /CUSTODY_COMPLETENESS_VIOLATION/,
    /CUSTODY_IMMUTABILITY_VIOLATION/,
    /BEFORE UPDATE OR DELETE ON public\."OperationalFact"/,
    /BEFORE UPDATE OR DELETE ON public\."FactLegacyTemperatureLogLink"/,
    /BEFORE UPDATE OR DELETE ON public\."FactCustodyReceipt"/,
    /BEFORE TRUNCATE ON public\."OperationalFact"/,
    /BEFORE TRUNCATE ON public\."FactLegacyTemperatureLogLink"/,
    /BEFORE TRUNCATE ON public\."FactCustodyReceipt"/,
  ]);
});

test("contains an exact rollback template in dependency order", () => {
  assert.notEqual(rollbackStart, -1);
  expectAll(rollback, [
    /-- BEGIN;/, /-- COMMIT;/,
    /DROP TRIGGER "OperationalFact_custody_complete"/,
    /DROP FUNCTION public\.enforce_operational_fact_custody_complete\(\)/,
    /DROP CONSTRAINT "FactLegacyTemperatureLogLink_linkMode_check"/,
    /DROP CONSTRAINT "OperationalFact_factType_check"/,
  ]);
  assert.ok(rollback.indexOf("DROP TRIGGER") < rollback.indexOf("DROP FUNCTION"));
  assert.ok(rollback.indexOf("DROP FUNCTION") < rollback.indexOf("DROP CONSTRAINT"));
});

test("rejects destructive and unauthorized migration content", () => {
  assert.doesNotMatch(migration, /CASCADE/);
  assert.doesNotMatch(rollback, /DELETE\s+FROM|TRUNCATE\s+public|DROP TABLE public\."TemperatureLog"|ALTER TABLE public\."TemperatureLog"/i);
  assert.doesNotMatch(migration, /CREATE ROLE|ALTER ROLE|GRANT\s+|prisma\s+(migrate|db|generate|deploy|pull|format)/i);
  assert.doesNotMatch(migration, /<[A-Za-z][^>\r\n]*>/);
});

test("keeps the migration additive and uses the required custody object names", () => {
  assert.match(forward, /public\."OperationalFact"/);
  assert.match(forward, /public\."FactLegacyTemperatureLogLink"/);
  assert.match(forward, /public\."FactCustodyReceipt"/);
  assert.doesNotMatch(forward, /^\s*(?:CREATE\s+TABLE|DROP\s+|UPDATE\s+|DELETE\s+FROM|TRUNCATE\s+)/im);
});
