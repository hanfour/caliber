// Shared, stateless OAuth init/exchange contracts. The refresh runtime
// (TokenProvider/TokenRefresher/RefreshPolicy/RefreshApi) stays in
// apps/gateway; only the pieces apps/api needs for the interactive flow
// live here.

export type Platform = "anthropic" | "openai" | "gemini" | "antigravity";

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  tokenType?: string;
  scope?: string;
}

export interface OAuthService {
  platform: Platform;
  // Returns the redirectURI it actually used so callers (initiateOAuth)
  // can persist it and pass the SAME value to exchangeCode (PKCE/OAuth
  // require redirect_uri symmetry).
  generateAuthURL(opts: { redirectURI?: string }): Promise<{
    authUrl: string;
    state: string;
    codeVerifier: string;
    redirectURI: string;
  }>;
  exchangeCode(opts: {
    code: string;
    codeVerifier: string;
    redirectURI?: string;
  }): Promise<TokenSet>;
}

export class OAuthRefreshError extends Error {
  constructor(
    message: string,
    public readonly platform?: Platform,
  ) {
    super(message);
    this.name = "OAuthRefreshError";
  }
}

export class OAuthRefreshTokenInvalid extends OAuthRefreshError {
  constructor(
    message: string,
    public readonly platform: Platform,
  ) {
    super(message, platform);
    this.name = "OAuthRefreshTokenInvalid";
  }
}
