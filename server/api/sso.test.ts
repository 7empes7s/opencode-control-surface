import { describe, expect, it, vi, beforeEach } from "bun:test";
import { mapGroupsToRole } from "../sso/oidc.ts";
import { providerDefaults, extractGroupsFromClaims } from "../sso/mappers.ts";
import type { OidcClaims } from "../sso/types.ts";

describe("SSO oidc", () => {
  describe("mapGroupsToRole", () => {
    it("returns operator for first matching group", () => {
      expect(mapGroupsToRole(["operators"], { admins: "admin", operators: "operator" })).toBe("operator");
    });

    it("returns admin for matching admin group", () => {
      expect(mapGroupsToRole(["finance-admins"], { "finance-admins": "admin" })).toBe("admin");
    });

    it("returns viewer for matching viewer group", () => {
      expect(mapGroupsToRole(["readers"], { readers: "viewer" })).toBe("viewer");
    });

    it("returns viewer as default when no match", () => {
      expect(mapGroupsToRole(["unknown-group"], {})).toBe("viewer");
    });

    it("first match wins", () => {
      expect(mapGroupsToRole(["a", "b"], { a: "viewer", b: "admin" })).toBe("viewer");
    });

    it("ignores invalid role values", () => {
      expect(mapGroupsToRole(["x"], { x: "superuser" as "operator" })).toBe("viewer");
    });
  });
});

describe("SSO mappers", () => {
  describe("providerDefaults", () => {
    it("keycloak uses groups scope", () => {
      const defaults = providerDefaults("keycloak");
      expect(defaults.scopes).toContain("groups");
    });

    it("azure-ad uses GroupMember.Read.All", () => {
      const defaults = providerDefaults("azure-ad");
      expect(defaults.scopes).toContain("https://graph.microsoft.com/GroupMember.Read.All");
    });

    it("okta uses groups scope", () => {
      const defaults = providerDefaults("okta");
      expect(defaults.scopes).toContain("groups");
    });

    it("generic-oidc has openid profile email", () => {
      const defaults = providerDefaults("generic-oidc");
      expect(defaults.scopes).toEqual(["openid", "profile", "email"]);
    });
  });

  describe("extractGroupsFromClaims", () => {
    it("azure-ad extracts from groups claim", () => {
      const claims: OidcClaims = {
        sub: "u1",
        iss: "https://login.microsoftonline.com/",
        aud: "client-id",
        iat: 0,
        exp: 9999999999,
        groups: ["guid1", "guid2"],
      };
      expect(extractGroupsFromClaims(claims, "azure-ad")).toEqual(["guid1", "guid2"]);
    });

    it("keycloak extracts from realm_access.roles", () => {
      const claims: OidcClaims = {
        sub: "u1",
        iss: "https://keycloak.example.com/",
        aud: "client-id",
        iat: 0,
        exp: 9999999999,
        realm_access: { roles: ["role1", "role2"] },
      };
      expect(extractGroupsFromClaims(claims, "keycloak")).toEqual(["role1", "role2"]);
    });

    it("generic-oidc extracts from groups claim", () => {
      const claims: OidcClaims = {
        sub: "u1",
        iss: "https://idp.example.com/",
        aud: "client-id",
        iat: 0,
        exp: 9999999999,
        groups: ["group-a"],
      };
      expect(extractGroupsFromClaims(claims, "generic-oidc")).toEqual(["group-a"]);
    });

    it("returns empty array when no groups present", () => {
      const claims: OidcClaims = {
        sub: "u1",
        iss: "https://idp.example.com/",
        aud: "client-id",
        iat: 0,
        exp: 9999999999,
      };
      expect(extractGroupsFromClaims(claims, "generic-oidc")).toEqual([]);
    });
  });
});