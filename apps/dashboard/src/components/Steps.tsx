import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import {
	activeOrganizationId,
	AuthRequestError,
	authClient,
	unwrap,
} from "../lib/auth-client";
import { apiKeysQuery } from "../lib/queries";
import { Button } from "./ui/button";

/** A numbered step, ticked once done. */
export function Step({
	n,
	done,
	last = false,
	children,
}: {
	n: number;
	done: boolean;
	last?: boolean;
	children: React.ReactNode;
}) {
	return (
		<li
			className={`grid grid-cols-[32px_minmax(0,1fr)] gap-3.5 p-5 ${last ? "" : "border-b border-line"}`}
		>
			<span
				className={`flex size-7 items-center justify-center rounded-sm border font-mono text-xs ${
					done ? "border-lumen bg-lumen-wash text-lumen" : "border-line-strong bg-reef text-foam"
				}`}
			>
				{done ? "✓" : n}
			</span>
			<div className="flex min-w-0 flex-col gap-3">{children}</div>
		</li>
	);
}

export function Steps({ children }: { children: React.ReactNode }) {
	return (
		<ol className="flex flex-col overflow-hidden rounded-md border border-line bg-shelf">
			{children}
		</ol>
	);
}

/** Step 1 of connecting anything: create an API key, which the caller fills
 *  into what it shows next. The key is shown once. */
export function CreateKeyStep({
	title,
	defaultName,
	description,
	created,
	onCreated,
}: {
	title: string;
	defaultName: string;
	description: string;
	created: string | undefined;
	onCreated: (key: string) => void;
}) {
	const [name, setName] = useState(defaultName);
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const queryClient = useQueryClient();

	const create = async (e: React.FormEvent) => {
		e.preventDefault();
		setCreating(true);
		setError(null);
		try {
			const result = await unwrap(
				authClient.apiKey.create({
					name: name.trim() || defaultName,
					organizationId: await activeOrganizationId(),
				}),
			);
			if (!result?.key) throw new Error("The server didn't return the new key.");
			onCreated(result.key);
			queryClient.invalidateQueries({ queryKey: apiKeysQuery().queryKey });
		} catch (err) {
			setError(
				err instanceof AuthRequestError && err.status === 403
					? "Creating keys needs an admin or owner. Ask one for a key."
					: ((err as Error).message ?? "Couldn't create the key."),
			);
		} finally {
			setCreating(false);
		}
	};

	return (
		<Step n={1} done={created !== undefined}>
			<span className="flex min-h-7 items-center text-[15px] font-semibold text-foam">{title}</span>
			{created === undefined ? (
				<>
					<form onSubmit={create} className="flex flex-wrap items-center gap-2">
						<label htmlFor="new-key-name" className="sr-only">
							Key name
						</label>
						<input
							id="new-key-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder={defaultName}
							className="h-8 min-w-0 flex-[1_1_200px] rounded-sm border border-input bg-trench px-2.5 font-mono text-[13px] text-foam placeholder:text-silt"
						/>
						<Button type="submit" size="sm" disabled={creating}>
							{creating ? "Creating…" : "Create key"}
						</Button>
					</form>
					<span className="text-[13px] text-mist">
						{description} Revoke it from{" "}
						<Link to="/api-keys" className="text-link">
							API keys
						</Link>{" "}
						at any time.
					</span>
				</>
			) : (
				<span className="flex flex-wrap items-center gap-2.5 font-mono text-[12.5px] text-mist">
					<span className="rounded-xs border border-lumen-edge bg-lumen/8 px-2 py-1 text-foam">
						{created.slice(0, 8)}••••••••{created.slice(-4)}
					</span>
					created just now · filled in below · shown once
				</span>
			)}
			{error && <span className="text-[13px] text-coral">{error}</span>}
		</Step>
	);
}
