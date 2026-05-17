import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { extractTenantFromCert } from "../sso/mtls.ts";

describe("mtls", () => {
  describe("extractTenantFromCert", () => {
    it("extracts O= tenant from subject", () => {
      expect(extractTenantFromCert("CN=myapp,O=acme,C=US")).toBe("acme");
    });

    it("returns null when no O= field", () => {
      expect(extractTenantFromCert("CN=myapp,C=US")).toBe(null);
    });

    it("handles spaces after commas", () => {
      expect(extractTenantFromCert("C=US, O=widgets, CN=test")).toBe("widgets");
    });

    it("handles empty subject", () => {
      expect(extractTenantFromCert("")).toBe(null);
    });

    it("returns last O= value when multiple present", () => {
      expect(extractTenantFromCert("O=first,O=second,CN=app")).toBe("second");
    });
  });
});