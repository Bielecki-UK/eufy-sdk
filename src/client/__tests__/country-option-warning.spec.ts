import { describe, it, expect, vi } from "vitest";
import { EufyMega } from "../eufy-mega.js";

/**
 * The account country is read from `countryCode` alone and defaults to `"US"`. A caller that passes
 * `country` instead gets a client routed to the US shard, where login still succeeds and the house list
 * answers with an empty placeholder — so the misnamed option is reported at construction.
 */
function construct(extra: Record<string, unknown>) {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  new EufyMega({ email: "t@example.com", password: "x", logger: logger as never, ...extra });
  return logger.warn.mock.calls.map(([m]) => String(m));
}

describe("a misnamed country option", () => {
  it("warns when `country` is passed without `countryCode`", () => {
    const warnings = construct({ country: "GB" });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/"country"/);
    expect(warnings[0]).toMatch(/"countryCode"/);
  });

  it("stays quiet when `countryCode` is set", () => {
    expect(construct({ country: "GB", countryCode: "GB" })).toEqual([]);
  });

  it("stays quiet when only `countryCode` is set", () => {
    expect(construct({ countryCode: "GB" })).toEqual([]);
  });
});
