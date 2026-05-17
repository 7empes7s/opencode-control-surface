export type Role = "operator" | "viewer" | "admin";

export type SsoProviderKind = "keycloak" | "azure-ad" | "okta" | "google-workspace" | "generic-oidc";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  groupMapping: Record<string, Role>;
}

export interface OidcSession {
  sub: string;
  email: string;
  groups: string[];
  role: Role;
  accessToken: string;
  expiresAt: number;
}

export interface OidcProviderMeta {
  issuer: string;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl?: string;
  jwksUrl?: string;
  endSessionUrl?: string;
}

export interface OidcTokenResponse {
  accessToken: string;
  idToken?: string;
  tokenType: string;
  expiresIn: number;
  refreshToken?: string;
  scope?: string;
}

export interface OidcClaims {
  sub: string;
  email?: string;
  groups?: string[];
  roles?: string[];
  iss: string;
  aud: string | string[];
  iat: number;
  exp: number;
  nonce?: string;
  [key: string]: unknown;
}