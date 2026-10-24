import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import path from "node:path";
import type { Host, HostRequests } from "@shoal/client-core/host";
import { Schema } from "effect";

/** Long enough for any settings form, short enough that nobody can make the worker buffer much. */
const MAX_BODY_BYTES = 64 * 1024;

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".json": "application/json",
};

/** Checks for the requests that take something, since a browser can send anything. */
const PARAMS: Partial<Record<keyof HostRequests, Schema.Decoder<unknown>>> = {
	setAvailability: Schema.Union([
		Schema.Literal("on"),
		Schema.Literal("off"),
		Schema.Struct({ pausedUntil: Schema.Number }),
	]),
	saveSettings: Schema.Struct({
		serverUrl: Schema.String,
		token: Schema.String,
		backends: Schema.Array(Schema.String),
		name: Schema.String,
		concurrency: Schema.Number,
		launchAtLogin: Schema.Boolean,
	}),
	unloadModel: Schema.Struct({ backend: Schema.String, id: Schema.String }),
};

export const isLoopback = (host: string) =>
	host === "localhost" || (isIP(host) === 4 && host.startsWith("127.")) || host === "::1";

export interface UiServerOptions {
	readonly host: Host;
	readonly bindHost: string;
	readonly port: number;
	/** What a browser must present once to get a session. */
	readonly accessToken: string;
	/** Serves HTTPS when present. */
	readonly tls?: { readonly cert: Buffer; readonly key: Buffer };
	/** The built web UI: index.html and its assets. */
	readonly assetsDir: string;
}

export interface UiServer {
	/** Where the UI is, without the access token. */
	readonly url: string;
	readonly close: () => Promise<void>;
}

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

const sameToken = (given: string, expected: string) => {
	const a = Buffer.from(given);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
};

const readJson = (request: http.IncomingMessage): Promise<unknown> =>
	new Promise((resolve, reject) => {
		if (!request.headers["content-type"]?.startsWith("application/json")) {
			// Browsers can't send JSON across sites without a CORS preflight, which this server never answers.
			reject(new HttpError(415, "Send JSON."));
			return;
		}
		const chunks: Array<Buffer> = [];
		let size = 0;
		request.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new HttpError(413, "Request too large."));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"));
			} catch {
				reject(new HttpError(400, "That isn't JSON."));
			}
		});
		request.on("error", reject);
	});

/** Serves the worker UI and its API, for anyone holding the access token. */
export const startUiServer = async (options: UiServerOptions): Promise<UiServer> => {
	const assetsDir = path.resolve(options.assetsDir);
	const sessions = new Set<string>();
	const handlers = options.host.handlers as Record<string, (params: unknown) => unknown>;
	// Browsers share cookies across ports, so workers on one machine would sign each other out under one name.
	const sessionCookie = `shoal_ui_${options.port}`;

	const sessionOf = (request: http.IncomingMessage) => {
		for (const part of request.headers.cookie?.split(";") ?? []) {
			const [name, value] = part.trim().split("=");
			if (name === sessionCookie && value !== undefined && sessions.has(value)) return value;
		}
		return null;
	};

	const requireSession = (request: http.IncomingMessage) => {
		if (sessionOf(request) === null) throw new HttpError(401, "Sign in first.");
	};

	const sendJson = (response: http.ServerResponse, status: number, body: unknown) => {
		response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
		response.end(JSON.stringify(body ?? null));
	};

	const serveFile = async (response: http.ServerResponse, pathname: string) => {
		const file = path.resolve(assetsDir, `.${pathname === "/" ? "/index.html" : pathname}`);
		if (!file.startsWith(assetsDir + path.sep)) throw new HttpError(404, "Not found.");
		let body: Buffer;
		try {
			body = await readFile(file);
		} catch {
			throw new HttpError(404, "Not found.");
		}
		response.writeHead(200, {
			"Content-Type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
			// Vite names assets by their content; index.html must always be fresh.
			"Cache-Control": pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
		});
		response.end(body);
	};

	const streamState = (request: http.IncomingMessage, response: http.ServerResponse) => {
		response.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-store",
			Connection: "keep-alive",
		});
		const send = (state: unknown) => response.write(`data: ${JSON.stringify(state)}\n\n`);
		send(options.host.state());
		// The host sends the state at least every second, which also keeps proxies from closing an idle stream.
		const unsubscribe = options.host.subscribe(send);
		request.on("close", unsubscribe);
	};

	const route = async (request: http.IncomingMessage, response: http.ServerResponse) => {
		const { pathname } = new URL(request.url ?? "/", "http://worker");
		const method = request.method ?? "GET";

		if (pathname === "/api/login" && method === "POST") {
			const body = (await readJson(request)) as { token?: unknown } | null;
			if (typeof body?.token !== "string" || !sameToken(body.token, options.accessToken)) {
				throw new HttpError(401, "That token isn't right.");
			}
			const session = randomBytes(32).toString("base64url");
			sessions.add(session);
			const secure = options.tls ? "; Secure" : "";
			response.writeHead(204, {
				"Set-Cookie": `${sessionCookie}=${session}; HttpOnly; SameSite=Strict; Path=/${secure}`,
			});
			response.end();
			return;
		}
		if (pathname === "/api/session" && method === "GET") {
			requireSession(request);
			response.writeHead(204).end();
			return;
		}
		if (pathname === "/api/state" && method === "GET") {
			requireSession(request);
			streamState(request, response);
			return;
		}
		const requestName = /^\/api\/request\/([A-Za-z]+)$/.exec(pathname)?.[1];
		if (requestName !== undefined && method === "POST") {
			requireSession(request);
			if (!Object.hasOwn(handlers, requestName)) throw new HttpError(404, `No request named ${requestName}.`);
			const body = await readJson(request);
			const schema = PARAMS[requestName as keyof HostRequests];
			let params: unknown;
			try {
				params = schema ? Schema.decodeUnknownSync(schema)(body) : undefined;
			} catch (error) {
				throw new HttpError(400, `Bad ${requestName} request: ${(error as Error).message}`);
			}
			sendJson(response, 200, await handlers[requestName](params));
			return;
		}
		if (pathname.startsWith("/api/")) throw new HttpError(404, "Not found.");
		if (method !== "GET") throw new HttpError(405, "Method not allowed.");
		await serveFile(response, pathname);
	};

	const listener = (request: http.IncomingMessage, response: http.ServerResponse) => {
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader("Referrer-Policy", "no-referrer");
		response.setHeader("X-Frame-Options", "DENY");
		response.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
		route(request, response).catch((error: unknown) => {
			if (response.headersSent) {
				response.destroy();
				return;
			}
			const status = error instanceof HttpError ? error.status : 500;
			if (status === 500) console.error("worker UI request failed:", error);
			const message = error instanceof Error ? error.message : String(error);
			response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }).end(message);
		});
	};

	const server = options.tls
		? https.createServer({ cert: options.tls.cert, key: options.tls.key }, listener)
		: http.createServer(listener);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, options.bindHost, () => {
			server.off("error", reject);
			resolve();
		});
	});

	const shownHost = isIP(options.bindHost) === 6 ? `[${options.bindHost}]` : options.bindHost;
	return {
		url: `${options.tls ? "https" : "http"}://${shownHost}:${options.port}/`,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
};
