import { auth } from "@shoal/db/auth";

export interface VerifiedKey {
  organizationId: string;
  keyId: string | null;
}

export class UnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/**
 * Validate a request via either:
 * - `Authorization: Bearer <key>` header (external clients)
 * - `x-api-key` header (Anthropic-style; Claude Code and the Anthropic SDK)
 * - A logged-in session cookie with an active organization (internal dashboard)
 *
 * Throws `UnauthorizedError` if none succeed. The auth layer does not produce
 * HTTP responses — callers (HTTP middleware, WS upgrade hook, etc.) decide how
 * to render the failure for their transport.
 */
export async function requireApiKey(req: Request): Promise<VerifiedKey> {
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return verifyKey(authHeader.slice(7));
  }

  const apiKeyHeader = req.headers.get("x-api-key");
  if (apiKeyHeader) {
    return verifyKey(apiKeyHeader);
  }

  const session = await auth.api.getSession({ headers: req.headers });
  if (session?.session.activeOrganizationId) {
    return {
      organizationId: session.session.activeOrganizationId,
      keyId: null,
    };
  }

  throw new UnauthorizedError();
}

/**
 * Verify a raw API key value (e.g. from a WebSocket query param).
 * Throws `UnauthorizedError` if the key is invalid.
 */
export async function verifyKey(key: string): Promise<VerifiedKey> {
  const result = await auth.api.verifyApiKey({ body: { key } });

  if (!result.valid || !result.key) {
    throw new UnauthorizedError("Invalid API key");
  }

  return {
    organizationId: result.key.referenceId,
    keyId: result.key.id,
  };
}
