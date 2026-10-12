import { apiKeyClient } from "@better-auth/api-key/client";
import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
	plugins: [organizationClient(), apiKeyClient()],
});

export const { signIn, signUp, signOut, useSession } = authClient;

/** A better-auth error, with the HTTP status the server answered. */
export class AuthRequestError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "AuthRequestError";
	}
}

/** Unwrap a better-auth client result, throwing its error so callers (and
 *  React Query) handle failures like any rejected promise. */
export async function unwrap<T>(
	result: Promise<
		| { data: T; error: null }
		| { data: null; error: { message?: string; status: number; statusText: string } }
	>,
): Promise<T> {
	const { data, error } = await result;
	if (error) {
		throw new AuthRequestError(error.message ?? error.statusText, error.status);
	}
	return data as T;
}

/** The session's active organization, for better-auth calls that take it
 *  explicitly. */
export async function activeOrganizationId(): Promise<string | undefined> {
	const session = await unwrap(authClient.getSession());
	return session?.session.activeOrganizationId ?? undefined;
}
