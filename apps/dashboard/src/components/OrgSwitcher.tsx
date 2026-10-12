import { useForm } from "@tanstack/react-form";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { useState } from "react";
import { authClient } from "../lib/auth-client";
import { Button } from "./ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "./ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";

interface Org {
	id: string;
	name: string;
	slug: string;
}

function slugify(name: string): string {
	return name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
}

export function OrgSwitcher({
	orgs,
	activeOrg,
}: {
	orgs: Org[];
	activeOrg: Org | null;
}) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const [menuOpen, setMenuOpen] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Everything cached belongs to the previous organization (its members,
	// keys, usage and the member's permissions there), so refetch it all,
	// then re-run route loaders.
	async function refreshAuth() {
		await queryClient.invalidateQueries();
		await router.invalidate();
	}

	const form = useForm({
		defaultValues: { name: "" },
		onSubmit: async ({ value }) => {
			const trimmed = value.name.trim();
			const slug = slugify(trimmed);
			if (!slug) {
				setError("Name must contain at least one letter or number");
				return;
			}
			setError(null);
			const { data, error: createError } = await authClient.organization.create(
				{
					name: trimmed,
					slug,
				},
			);
			if (createError || !data) {
				setError(createError?.message ?? "Failed to create organization");
				return;
			}
			await authClient.organization.setActive({ organizationId: data.id });
			handleCreateOpenChange(false);
			await refreshAuth();
		},
	});

	async function setActive(orgId: string) {
		await authClient.organization.setActive({ organizationId: orgId });
		await refreshAuth();
	}

	function handleCreateOpenChange(next: boolean) {
		setCreateOpen(next);
		if (!next) {
			setError(null);
			form.reset();
		}
	}

	if (!activeOrg) {
		return (
			<span className="text-sm text-muted-foreground">No organization</span>
		);
	}

	return (
		<>
			<DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
				<DropdownMenuTrigger asChild>
					<Button variant="ghost" size="sm" className="gap-2 pr-2.5 pl-1.5 text-foam">
						<OrgInitial name={activeOrg.name} />
						<span className="text-[13px]">{activeOrg.name}</span>
						<ChevronsUpDown className="size-3.5 text-muted-foreground" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="min-w-[240px]">
					<DropdownMenuLabel className="text-xs text-muted-foreground">
						Organizations
					</DropdownMenuLabel>
					{orgs.map((org) => (
						<DropdownMenuItem
							key={org.id}
							onClick={() => setActive(org.id)}
							className="gap-2"
						>
							<OrgInitial name={org.name} />
							<span className="flex-1">{org.name}</span>
							{org.id === activeOrg.id && <Check className="size-4" />}
						</DropdownMenuItem>
					))}
					<DropdownMenuSeparator />
					<DropdownMenuItem
						className="gap-2"
						onSelect={() => {
							setMenuOpen(false);
							setCreateOpen(true);
						}}
					>
						<Plus className="size-4" />
						Create organization
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>

			<Dialog open={createOpen} onOpenChange={handleCreateOpenChange}>
				<DialogContent>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							form.handleSubmit();
						}}
					>
						<DialogHeader>
							<DialogTitle>Create organization</DialogTitle>
							<DialogDescription>
								Organizations group workers, members, and API keys. Once created
								it'll become your active organization.
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
											placeholder="Organization name"
											disabled={form.state.isSubmitting}
											className="w-full rounded-sm border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-2 text-sm text-[var(--sea-ink)] focus:border-[var(--lagoon)] focus:outline-none"
										/>
										{field.state.value.trim() && (
											<p className="mt-1 text-xs text-muted-foreground">
												Slug: <code>{slugify(field.state.value) || "—"}</code>
											</p>
										)}
										{field.state.meta.isTouched &&
											field.state.meta.errors.length > 0 && (
												<span className="mt-1 block text-xs text-coral">
													{String(field.state.meta.errors[0])}
												</span>
											)}
									</label>
								)}
							</form.Field>

							{error && <p className="mt-3 text-xs text-coral">{error}</p>}
						</div>

						<DialogFooter>
							<button
								type="button"
								onClick={() => handleCreateOpenChange(false)}
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
				</DialogContent>
			</Dialog>
		</>
	);
}

/** An organization's initial in a hairline square, in place of a logo. */
function OrgInitial({ name }: { name: string }) {
	return (
		<span
			aria-hidden="true"
			className="flex size-5 shrink-0 items-center justify-center rounded-xs border border-[var(--line-strong)] bg-[var(--surface-strong)] font-mono text-[11px] font-medium text-[var(--sea-ink-soft)] uppercase"
		>
			{name.trim().charAt(0) || "?"}
		</span>
	);
}
