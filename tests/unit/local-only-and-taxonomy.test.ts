import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetEnvCache } from "@/lib/config";
import { taxonomySchema } from "@/services/cv-engine/taxonomy-store";
import { RoleTaxonomy } from "@/services/cv-engine/taxonomy";

const SAVED = { ...process.env };

beforeEach(() => {
  delete process.env.LOCAL_ONLY;
  delete process.env.EXTRACTION_ENGINE;
  resetEnvCache();
});
afterEach(() => {
  process.env = { ...SAVED };
  resetEnvCache();
});

/**
 * LOCAL_ONLY is a promise about where CV content can go, so it is enforced in
 * two places: configuration refuses a contradicting engine at startup, and the
 * single function every model call passes through refuses outright. One without
 * the other is a preference, not a guarantee.
 */
describe("LOCAL_ONLY", () => {
  it("is off by default, leaving the local engine as the default anyway", async () => {
    const { env } = await import("@/lib/config");
    expect(env().LOCAL_ONLY).toBe(false);
    expect(env().EXTRACTION_ENGINE).toBe("local");
  });

  it("accepts the local engine", async () => {
    process.env.LOCAL_ONLY = "true";
    process.env.EXTRACTION_ENGINE = "local";
    resetEnvCache();
    const { env, isLocalOnly } = await import("@/lib/config");
    expect(env().EXTRACTION_ENGINE).toBe("local");
    expect(isLocalOnly()).toBe(true);
  });

  it("refuses shadow and legacy at startup rather than at the first CV", async () => {
    for (const engine of ["shadow", "legacy"]) {
      process.env.LOCAL_ONLY = "true";
      process.env.EXTRACTION_ENGINE = engine;
      resetEnvCache();
      const { env } = await import("@/lib/config");
      expect(() => env()).toThrow(/LOCAL_ONLY/);
    }
  });

  it("refuses a model call even with a provider injected", async () => {
    process.env.LOCAL_ONLY = "true";
    process.env.EXTRACTION_ENGINE = "local";
    resetEnvCache();
    const { extractWithLLM } = await import("@/services/llm");
    // An injected provider bypasses credential checks, so this proves the guard
    // is on the call itself rather than on configuration.
    await expect(
      extractWithLLM({
        cvText: "Rahul Sharma",
        model: "x",
        temperature: 0,
        timeoutMs: 1000,
        promptVersion: "v1",
        provider: { name: "openai", extract: async () => { throw new Error("should never be reached"); } },
      }),
    ).rejects.toThrow(/LOCAL_ONLY/);
  });
});

describe("role taxonomy override", () => {
  const minimal = {
    version: "test-1",
    families: [{ family: "Engineering", roles: [{ canonical: "Golang Developer", aliases: ["Go Developer"] }] }],
    seniorityPrefixes: ["Senior"],
    genericRejects: ["Fresher"],
  };

  it("accepts a well-formed taxonomy", () => {
    const parsed = taxonomySchema.parse(minimal);
    expect(parsed.families[0].roles[0].canonical).toBe("Golang Developer");
  });

  it("rejects a malformed taxonomy rather than storing it", () => {
    expect(() => taxonomySchema.parse({ version: "x", families: [] })).toThrow();
    expect(() => taxonomySchema.parse({ families: [{ family: "E", roles: [] }] })).toThrow();
  });

  it("resolves a role that only the override knows about", () => {
    // The bundled taxonomy has no "Golang Developer" canonical entry; adding one
    // through the override is the whole point of not needing a deploy.
    const overridden = new RoleTaxonomy(taxonomySchema.parse(minimal));
    const hit = overridden.match("Go Developer");
    expect(hit?.canonical).toBe("Golang Developer");
    expect(hit?.matchedOn).toBe("alias");
  });

  it("keeps the source data available for the admin UI", () => {
    const t = new RoleTaxonomy(taxonomySchema.parse(minimal));
    expect(t.data.version).toBe("test-1");
    expect(t.data.families).toHaveLength(1);
  });
});
