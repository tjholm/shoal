import { isSignupAllowed } from "@shoal/db/auth";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { USAGE_RETENTION_DAYS } from "../env";

export interface ServerConfig {
	/** Days of usage data retained before the prune job deletes it. */
	usageRetentionDays: number;
	/** Public WebSocket URL workers should connect to. */
	serverWsUrl: string;
}

export interface SignupAvailability {
	allowed: boolean;
}

function deriveServerWsUrl(headers: Headers): string {
	const envUrl = process.env.SHOAL_SERVER_URL;
	if (envUrl) {
		return `${envUrl.replace(/^http(s?):\/\//, "ws$1://").replace(/\/+$/, "")}/ws/workers`;
	}
	const fwdHost = headers.get("x-forwarded-host");
	const fwdProto = headers.get("x-forwarded-proto");
	if (fwdHost) {
		const proto = fwdProto === "https" ? "wss" : "ws";
		return `${proto}://${fwdHost}/ws/workers`;
	}
	const host = headers.get("host") ?? "localhost:3000";
	const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|$)/.test(host);
	const proto = isLocal ? "ws" : "wss";
	return `${proto}://${host}/ws/workers`;
}

export const getServerConfig = createServerFn({ method: "GET" }).handler(
	async (): Promise<ServerConfig> => {
		const headers = new Headers(
			getRequestHeaders() as unknown as Record<string, string>,
		);
		return {
			usageRetentionDays: USAGE_RETENTION_DAYS,
			serverWsUrl: deriveServerWsUrl(headers),
		};
	},
);

export const getSignupAvailability = createServerFn({ method: "GET" }).handler(
	async (): Promise<SignupAvailability> => ({
		allowed: await isSignupAllowed(),
	}),
);
