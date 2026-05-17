import type { OidcConfig, OidcClaims, SsoProviderKind } from "./types.ts";

export function providerDefaults(kind: SsoProviderKind): Partial<OidcConfig> {
  switch (kind) {
    case "keycloak":
      return {
        scopes: ["openid", "profile", "email", "groups"],
      };
    case "azure-ad":
      return {
        scopes: ["openid", "profile", "email", "https://graph.microsoft.com/GroupMember.Read.All"],
      };
    case "okta":
      return {
        scopes: ["openid", "profile", "email", "groups"],
      };
    case "google-workspace":
      return {
        scopes: ["openid", "profile", "email"],
      };
    case "generic-oidc":
    default:
      return {
        scopes: ["openid", "profile", "email"],
      };
  }
}

export function extractGroupsFromClaims(claims: OidcClaims, kind: SsoProviderKind): string[] {
  switch (kind) {
    case "azure-ad": {
      const groups = claims.groups;
      if (Array.isArray(groups)) return groups.map(String);
      if (typeof groups === "string") return [groups];
      return [];
    }
    case "keycloak": {
      const realmAccess = claims.realm_access as { roles?: string[] } | undefined;
      if (realmAccess?.roles && Array.isArray(realmAccess.roles)) {
        return realmAccess.roles;
      }
      if (claims.groups && Array.isArray(claims.groups)) {
        return claims.groups.map(String);
      }
      return [];
    }
    case "okta":
    case "google-workspace":
    case "generic-oidc":
    default: {
      if (claims.groups && Array.isArray(claims.groups)) {
        return claims.groups.map(String);
      }
      if (claims.roles && Array.isArray(claims.roles)) {
        return claims.roles.map(String);
      }
      return [];
    }
  }
}