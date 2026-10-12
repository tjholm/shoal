import { useLiveQuery } from "@tanstack/react-db";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { CopyButton } from "../../components/CopyButton";
import { Page, TableHead } from "../../components/Page";
import { Button } from "../../components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "../../components/ui/dialog";
import { activeOrganizationId, authClient, unwrap } from "../../lib/auth-client";
import { workersCollection } from "../../lib/collections";
import { apiKeysQuery } from "../../lib/queries";

export const Route = createFileRoute("/_authed/api-keys")({
	loader: ({ context: { queryClient } }) => queryClient.ensureQueryData(apiKeysQuery()),
	component: ApiKeys,
});

const DESCRIPTION = (
	<>
		One key type for both jobs: <span className="font-mono text-foam">Bearer</span> for API calls,{" "}
		<span className="font-mono text-foam">--token</span> for workers.
	</>
);

const EXPIRY = {
	never: { label: "Never", seconds: undefined },
	"30d": { label: "In 30 days", seconds: 30 * 86_400 },
	"90d": { label: "In 90 days", seconds: 90 * 86_400 },
} as const;

type Expiry = keyof typeof EXPIRY;

interface CreatedKey {
	name: string;
	key: string;
}

function ApiKeys() {
	const { data } = useSuspenseQuery(apiKeysQuery());
	const [created, setCreated] = useState<CreatedKey | null>(null);
	const queryClient = useQueryClient();
	const refresh = () => queryClient.invalidateQueries({ queryKey: apiKeysQuery().queryKey });

	if (!data.permitted) {
		return (
			<Page title="API keys" description={DESCRIPTION}>
				<section className="rise-in rounded-md border border-line bg-shelf px-[18px] py-5">
					<h2 className="mb-1.5 text-[15px] font-semibold text-foam">Admins manage keys</h2>
					<p className="text-[13px] text-mist">
						Creating and revoking API keys needs an admin or owner role in this organization.
						Ask one for a key to run a worker or call the API.
					</p>
				</section>
			</Page>
		);
	}

	return (
		<Page title="API keys" description={DESCRIPTION}>
			{created ? (
				<NewKey created={created} onDone={() => setCreated(null)} />
			) : (
				<CreateKeyForm
					onCreated={(key) => {
						setCreated(key);
						refresh();
					}}
				/>
			)}
			<KeyTable keys={data.keys} newKeyName={created?.name} onChange={refresh} />
			<p className="text-xs text-silt">
				Deleting a key stops new API calls and worker connections with it. Workers already
				connected with it stay connected until they next reconnect.
			</p>
		</Page>
	);
}

function CreateKeyForm({ onCreated }: { onCreated: (key: CreatedKey) => void }) {
	const [name, setName] = useState("");
	const [expiry, setExpiry] = useState<Expiry>("never");
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const create = async (e: React.FormEvent) => {
		e.preventDefault();
		const trimmed = name.trim();
		if (!trimmed) return;
		setCreating(true);
		setError(null);
		try {
			const result = await unwrap(
				authClient.apiKey.create({
					name: trimmed,
					organizationId: await activeOrganizationId(),
					expiresIn: EXPIRY[expiry].seconds,
				}),
			);
			if (!result?.key) throw new Error("The server didn't return the new key.");
			setName("");
			onCreated({ name: trimmed, key: result.key });
		} catch (err) {
			setError((err as Error).message ?? "Couldn't create the key.");
		} finally {
			setCreating(false);
		}
	};

	return (
		<form
			aria-label="Create key"
			onSubmit={create}
			className="rise-in flex flex-col gap-3 rounded-md border border-line bg-shelf px-[18px] py-4"
		>
			<div className="flex flex-wrap items-end gap-3">
				<div className="flex min-w-0 flex-[999_1_260px] flex-col gap-1.5">
					<label htmlFor="key-name" className="text-[13px] font-medium text-foam">
						Name
					</label>
					<input
						id="key-name"
						required
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="framework-desktop worker"
						className="h-10 rounded-sm border border-input bg-trench px-3 font-mono text-[13px] text-foam placeholder:text-silt"
					/>
				</div>
				<div className="flex flex-[1_1_160px] flex-col gap-1.5">
					<label htmlFor="key-expiry" className="text-[13px] font-medium text-foam">
						Expires
					</label>
					<select
						id="key-expiry"
						value={expiry}
						onChange={(e) => setExpiry(e.target.value as Expiry)}
						className="h-10 rounded-sm border border-input bg-trench pl-3 text-sm text-foam"
					>
						{Object.entries(EXPIRY).map(([value, { label }]) => (
							<option key={value} value={value}>
								{label}
							</option>
						))}
					</select>
				</div>
				<Button type="submit" disabled={creating}>
					{creating ? "Creating…" : "Create key"}
				</Button>
			</div>
			{error && <span className="text-xs text-coral">{error}</span>}
		</form>
	);
}

/** The new key, shown once, with how to use it. */
function NewKey({ created, onDone }: { created: CreatedKey; onDone: () => void }) {
	const short = `${created.key.slice(0, 8)}…${created.key.slice(-4)}`;
	return (
		<section
			aria-label="New key"
			className="rise-in flex flex-col gap-3.5 rounded-md border border-lumen/45 bg-lumen/6 p-[18px]"
		>
			<div className="flex flex-wrap items-center justify-between gap-2.5">
				<span className="text-[15px] font-semibold text-foam">{created.name}</span>
				<span className="font-mono text-xs text-amber">◇ shown once. Copy it now.</span>
			</div>
			<div className="flex items-center gap-2 rounded-sm border border-line-strong bg-trench py-1.5 pr-1.5 pl-3.5">
				<code className="min-w-0 grow overflow-x-auto border-0 bg-transparent p-0 font-mono text-[13.5px] whitespace-nowrap text-foam">
					{created.key}
				</code>
				<CopyButton
					value={created.key}
					label="Copy key"
					className="size-8 border border-line-strong bg-reef text-foam"
				/>
			</div>
			<div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-2.5">
				<Usage label="As a worker" text={`npx @shoal.school/cli worker start --token ${short}`} />
				<Usage label="As an API client" text={`Authorization: Bearer ${short}`} />
			</div>
			<div className="flex justify-end">
				<Button variant="secondary" size="sm" onClick={onDone}>
					I've saved it
				</Button>
			</div>
		</section>
	);
}

function Usage({ label, text }: { label: string; text: string }) {
	return (
		<div className="flex flex-col gap-1 rounded-sm border border-line bg-trench px-3 py-2.5">
			<span className="font-mono text-[10.5px] tracking-[0.08em] text-silt uppercase">{label}</span>
			<code className="truncate border-0 bg-transparent p-0 font-mono text-xs text-mist">{text}</code>
		</div>
	);
}

interface ApiKey {
	id: string;
	name: string | null;
	start: string | null;
	createdAt: Date | string;
	lastRequest: Date | string | null;
	expiresAt: Date | string | null;
}

const KEY_COLUMNS = "minmax(0,1.6fr) 150px minmax(0,1.5fr) 110px 100px 80px";

function KeyTable({
	keys,
	newKeyName,
	onChange,
}: {
	keys: ReadonlyArray<ApiKey>;
	newKeyName: string | undefined;
	onChange: () => void;
}) {
	const { data: workers } = useLiveQuery((q) => q.from({ worker: workersCollection }));
	const sorted = [...keys].sort(
		(a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
	);
	return (
		<section aria-label="Keys" className="rise-in overflow-hidden rounded-md border border-line bg-shelf">
			{sorted.length === 0 ? (
				<p className="px-[18px] py-10 text-center text-[13px] text-silt">
					No keys yet. Create one above to connect a worker or call the API.
				</p>
			) : (
				<div className="overflow-x-auto">
					<div className="min-w-[820px]">
						<TableHead columns={KEY_COLUMNS}>
							<span>Name</span>
							<span>Key</span>
							<span>Used by</span>
							<span>Last used</span>
							<span>Expires</span>
							<span />
						</TableHead>
						{sorted.map((key) => (
							<KeyRow
								key={key.id}
								apiKey={key}
								isNew={key.name === newKeyName && Date.now() - new Date(key.createdAt).getTime() < 60_000}
								workers={(workers ?? []).filter((w) => w.keyId === key.id)}
								onChange={onChange}
							/>
						))}
					</div>
				</div>
			)}
		</section>
	);
}

function KeyRow({
	apiKey,
	isNew,
	workers,
	onChange,
}: {
	apiKey: ApiKey;
	isNew: boolean;
	workers: ReadonlyArray<{ workerId: string; name: string | null; online: boolean }>;
	onChange: () => void;
}) {
	const lastUsed = apiKey.lastRequest ? Date.now() - new Date(apiKey.lastRequest).getTime() : null;
	const expiresIn = apiKey.expiresAt ? new Date(apiKey.expiresAt).getTime() - Date.now() : null;
	return (
		<div
			className={`grid items-center gap-4 border-b border-reef px-[18px] py-3.5 last:border-b-0 ${isNew ? "bg-lumen/5" : ""}`}
			style={{ gridTemplateColumns: KEY_COLUMNS }}
		>
			<span className="flex min-w-0 flex-col gap-[3px]">
				<span className="flex min-w-0 items-center gap-2 text-sm font-medium text-foam">
					<span className="truncate">{apiKey.name ?? "unnamed"}</span>
					{isNew && (
						<span className="rounded-xs border border-lumen/45 px-[5px] py-px font-mono text-[10.5px] text-lumen">
							new
						</span>
					)}
				</span>
				<span className="text-xs text-silt">created {formatAgo(apiKey.createdAt)}</span>
			</span>
			<span className="font-mono text-[12.5px] text-mist">{apiKey.start ? `${apiKey.start}…` : "—"}</span>
			<span className="flex min-w-0 flex-wrap gap-1.5">
				{workers.length === 0 ? (
					<span className="font-mono text-xs text-silt">no worker</span>
				) : (
					workers.map((w) => (
						<Link
							key={w.workerId}
							to="/workers/$workerId"
							params={{ workerId: w.workerId }}
							className="inline-flex h-[22px] items-center gap-1.5 rounded-xs border border-line px-[7px] font-mono text-[11.5px] text-mist hover:border-line-strong hover:text-foam"
						>
							<span aria-hidden="true" className={w.online ? "text-lumen" : "text-coral"}>
								{w.online ? "●" : "×"}
							</span>
							{w.name ?? w.workerId.slice(0, 8)}
						</Link>
					))
				)}
			</span>
			<span
				className={`font-mono text-xs ${lastUsed !== null && lastUsed < 5 * 60_000 ? "text-lumen" : "text-mist"}`}
			>
				{lastUsed === null ? "never" : lastUsed < 60_000 ? "now" : `${formatSpan(lastUsed)} ago`}
			</span>
			<span
				className={`font-mono text-xs ${expiresIn !== null && expiresIn < 7 * 86_400_000 ? "text-amber" : "text-mist"}`}
			>
				{expiresIn === null ? "never" : expiresIn <= 0 ? "expired" : `in ${formatSpan(expiresIn)}`}
			</span>
			<span className="flex justify-end">
				<DeleteKeyDialog apiKey={apiKey} inUse={workers.length} onDeleted={onChange} />
			</span>
		</div>
	);
}

function DeleteKeyDialog({
	apiKey,
	inUse,
	onDeleted,
}: {
	apiKey: ApiKey;
	inUse: number;
	onDeleted: () => void;
}) {
	const [open, setOpen] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const remove = async () => {
		setDeleting(true);
		setError(null);
		try {
			await unwrap(authClient.apiKey.delete({ keyId: apiKey.id }));
			setOpen(false);
			onDeleted();
		} catch (err) {
			setError((err as Error).message ?? "Couldn't delete the key.");
		} finally {
			setDeleting(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={(next) => !deleting && setOpen(next)}>
			<DialogTrigger asChild>
				<Button variant="destructive" size="sm" className="h-[30px] px-2.5 text-[12.5px]">
					Delete
				</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Delete key "{apiKey.name ?? "unnamed"}"?</DialogTitle>
					<DialogDescription>
						API calls and new worker connections with it stop working.
						{inUse > 0 &&
							` ${inUse} ${inUse === 1 ? "worker uses" : "workers use"} it; they stay connected until they next reconnect, then need a new key.`}
					</DialogDescription>
				</DialogHeader>
				{error && <p className="text-[13px] text-coral">{error}</p>}
				<DialogFooter>
					<Button variant="ghost" onClick={() => setOpen(false)} disabled={deleting}>
						Cancel
					</Button>
					<Button variant="destructive" onClick={remove} disabled={deleting}>
						{deleting ? "Deleting…" : "Delete key"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function formatSpan(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `${Math.max(1, minutes)}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

function formatAgo(date: Date | string): string {
	return `${formatSpan(Math.max(0, Date.now() - new Date(date).getTime()))} ago`;
}
