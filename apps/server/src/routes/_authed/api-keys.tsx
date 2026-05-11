import { useForm } from "@tanstack/react-form";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
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
import { apiKeysQuery } from "../../lib/queries";
import { createApiKey, deleteApiKey } from "../../server/functions/api-keys";

export const Route = createFileRoute("/_authed/api-keys")({
	loader: ({ context: { queryClient } }) =>
		queryClient.ensureQueryData(apiKeysQuery()),
	component: ApiKeys,
});

function ApiKeys() {
	const { data } = useSuspenseQuery(apiKeysQuery());
	const queryClient = useQueryClient();
	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: apiKeysQuery().queryKey });

	if (!data.permitted) {
		return (
			<PageShell>
				<section className="island-shell rounded-sm p-6">
					<h2 className="mb-2 text-base font-semibold text-[var(--sea-ink)]">
						Access restricted
					</h2>
					<p className="text-sm text-[var(--sea-ink-soft)]">
						Managing API keys requires an admin or owner role in this
						organization. Ask an admin if you need a key for a worker or client.
					</p>
				</section>
			</PageShell>
		);
	}

	return (
		<PageShell action={<CreateKey onCreated={refresh} />}>
			<section className="island-shell rounded-sm p-6">
				<div className="mb-5">
					<h2 className="text-base font-semibold text-[var(--sea-ink)]">
						Active Keys
					</h2>
					<p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
						Each key is scoped to your active organization
					</p>
				</div>

				{data.keys.length === 0 ? (
					<p className="text-sm text-[var(--sea-ink-soft)]">
						No API keys yet. Create one to get started.
					</p>
				) : (
					<div className="space-y-1">
						{data.keys.map((k) => (
							<div
								key={k.id}
								className="flex items-center justify-between rounded-sm px-3 py-3 hover:bg-[var(--surface-strong)]"
							>
								<div className="min-w-0">
									<div className="flex items-center gap-2">
										<span className="text-sm font-medium text-[var(--sea-ink)]">
											{k.name ?? "(unnamed)"}
										</span>
										{k.enabled === false && (
											<span className="rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-xs text-red-300">
												disabled
											</span>
										)}
									</div>
									<div className="mt-0.5 text-xs text-[var(--sea-ink-soft)]">
										Created {formatRelative(k.createdAt)}
										{" · "}
										{k.lastRequest
											? `Last used ${formatRelative(k.lastRequest)}`
											: "Never used"}
									</div>
								</div>
								<button
									type="button"
									onClick={async () => {
										await deleteApiKey({ data: { keyId: k.id } });
										refresh();
									}}
									className="text-sm text-red-400 hover:text-red-300"
								>
									Revoke
								</button>
							</div>
						))}
					</div>
				)}
			</section>
		</PageShell>
	);
}

function PageShell({
	children,
	action,
}: {
	children: React.ReactNode;
	action?: React.ReactNode;
}) {
	return (
		<main className="page-wrap px-4 pb-8 pt-10">
			<header className="rise-in mb-8 flex flex-wrap items-start justify-between gap-4">
				<div>
					<h1 className="display-title text-3xl text-[var(--sea-ink)] sm:text-4xl">
						API Keys
					</h1>
					<p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
						Tokens for API requests and worker connections
					</p>
				</div>
				{action}
			</header>
			{children}
		</main>
	);
}

function formatRelative(value: Date | string | number | null | undefined) {
	if (!value) return "—";
	const ts =
		typeof value === "object" ? value.getTime() : new Date(value).getTime();
	const diff = Date.now() - ts;
	const sec = Math.round(diff / 1000);
	if (sec < 60) return "just now";
	const min = Math.round(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.round(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const day = Math.round(hr / 24);
	if (day < 30) return `${day}d ago`;
	const mo = Math.round(day / 30);
	if (mo < 12) return `${mo}mo ago`;
	return `${Math.round(mo / 12)}y ago`;
}

function CreateKey({ onCreated }: { onCreated: () => void | Promise<void> }) {
	const [open, setOpen] = useState(false);
	const [createdSecret, setCreatedSecret] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const form = useForm({
		defaultValues: { name: "" },
		onSubmit: async ({ value }) => {
			setError(null);
			try {
				const result = await createApiKey({
					data: { name: value.name.trim() },
				});
				if (!result?.key) {
					setError("Failed to create key");
					return;
				}
				setCreatedSecret(result.key);
				await onCreated();
			} catch (err) {
				setError((err as Error).message ?? "Failed to create key");
			}
		},
	});

	function handleOpenChange(next: boolean) {
		setOpen(next);
		if (!next) {
			setCreatedSecret(null);
			setError(null);
			form.reset();
		}
	}

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogTrigger asChild>
				<Button
					variant="outline"
					size="sm"
					className="border-[var(--lagoon-line)] text-[var(--lagoon-deep)] hover:bg-[var(--lagoon-soft)] hover:text-[var(--lagoon)]"
				>
					Create API Key
				</Button>
			</DialogTrigger>
			<DialogContent>
				{createdSecret ? (
					<>
						<DialogHeader>
							<DialogTitle>Key created</DialogTitle>
							<DialogDescription>
								Copy this now — it won't be shown again.
							</DialogDescription>
						</DialogHeader>
						<code className="block break-all rounded-sm border border-[var(--line)] bg-[var(--surface)] p-3 text-sm text-[var(--sea-ink)]">
							{createdSecret}
						</code>
						<DialogFooter>
							<button
								type="button"
								onClick={() => navigator.clipboard.writeText(createdSecret)}
								className="rounded-sm border border-[var(--line)] px-3 py-1.5 text-sm text-[var(--sea-ink-soft)] hover:bg-[var(--surface)]"
							>
								Copy
							</button>
							<button
								type="button"
								onClick={() => handleOpenChange(false)}
								className="rounded-sm border border-[var(--lagoon-line)] bg-[var(--lagoon-soft)] px-3 py-1.5 text-sm font-semibold text-[var(--lagoon-deep)] hover:bg-[var(--lagoon-line)]"
							>
								Done
							</button>
						</DialogFooter>
					</>
				) : (
					<form
						onSubmit={(e) => {
							e.preventDefault();
							form.handleSubmit();
						}}
					>
						<DialogHeader>
							<DialogTitle>Create API Key</DialogTitle>
							<DialogDescription>
								Tokens authenticate API requests and worker connections for this
								organization.
							</DialogDescription>
						</DialogHeader>

						<div className="my-6">
							<form.Field
								name="name"
								validators={{
									onSubmit: ({ value }) =>
										!value.trim() ? "Name is required" : undefined,
								}}
							>
								{(field) => (
									<label className="block">
										<span className="mb-1 block text-sm font-semibold text-[var(--sea-ink-soft)]">
											Name
										</span>
										<input
											type="text"
											value={field.state.value}
											onChange={(e) => field.handleChange(e.target.value)}
											onBlur={field.handleBlur}
											placeholder="e.g. worker-1"
											disabled={form.state.isSubmitting}
											className="w-full rounded-sm border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-2 text-sm text-[var(--sea-ink)] focus:border-[var(--lagoon)] focus:outline-none"
										/>
										{field.state.meta.isTouched &&
											field.state.meta.errors.length > 0 && (
												<span className="mt-1 block text-xs text-red-400">
													{String(field.state.meta.errors[0])}
												</span>
											)}
									</label>
								)}
							</form.Field>

							{error && <p className="mt-3 text-xs text-red-400">{error}</p>}
						</div>

						<DialogFooter>
							<button
								type="button"
								onClick={() => handleOpenChange(false)}
								className="rounded-sm border border-[var(--line)] px-3 py-1.5 text-sm text-[var(--sea-ink-soft)] hover:bg-[var(--surface)]"
							>
								Cancel
							</button>
							<form.Subscribe
								selector={(state) =>
									[
										state.values.name,
										state.canSubmit,
										state.isSubmitting,
									] as const
								}
							>
								{([name, canSubmit, isSubmitting]) => (
									<button
										type="submit"
										disabled={!name.trim() || !canSubmit || isSubmitting}
										className="rounded-sm border border-[var(--lagoon-line)] bg-[var(--lagoon-soft)] px-4 py-1.5 text-sm font-semibold text-[var(--lagoon-deep)] hover:bg-[var(--lagoon-line)] disabled:opacity-50"
									>
										{isSubmitting ? "Creating..." : "Create"}
									</button>
								)}
							</form.Subscribe>
						</DialogFooter>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}
