import { useForm } from "@tanstack/react-form";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { MoreHorizontal, RefreshCw } from "lucide-react";
import { useState } from "react";
import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "../../components/ui/avatar";
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
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { invitationsQuery, membersQuery } from "../../lib/queries";
import {
	cancelInvitation,
	inviteMember,
} from "../../server/functions/invitations";
import { removeMember, updateMemberRole } from "../../server/functions/members";

export const Route = createFileRoute("/_authed/members")({
	loader: ({ context: { queryClient } }) =>
		Promise.all([
			queryClient.ensureQueryData(membersQuery()),
			queryClient.ensureQueryData(invitationsQuery()),
		]),
	component: Members,
});

type Role = "admin" | "member";

interface MemberUser {
	name: string;
	email: string;
	image?: string | null;
}

interface Member {
	id: string;
	role: string;
	user: MemberUser;
}

function Members() {
	const { data: members } = useSuspenseQuery(membersQuery());
	const { data: invitations } = useSuspenseQuery(invitationsQuery());
	const queryClient = useQueryClient();
	const pendingInvitations = invitations.filter((i) => i.status === "pending");
	const refresh = () => {
		queryClient.invalidateQueries({ queryKey: membersQuery().queryKey });
		queryClient.invalidateQueries({ queryKey: invitationsQuery().queryKey });
	};

	return (
		<main className="page-wrap px-4 pb-8 pt-10">
			<header className="rise-in mb-8 flex flex-wrap items-start justify-between gap-4">
				<div>
					<h1 className="display-title text-3xl text-[var(--sea-ink)] sm:text-4xl">
						Members
					</h1>
					<p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
						Manage your organization members and invitations
					</p>
				</div>
				<div className="flex items-center gap-2">
					<Button
						variant="ghost"
						size="icon"
						onClick={refresh}
						aria-label="Refresh"
					>
						<RefreshCw className="size-4" />
					</Button>
					<InviteForm onInvited={refresh} />
				</div>
			</header>

			<Panel
				title="Current Members"
				description="People who have access to this organization"
			>
				<div className="space-y-1">
					{members.map((m) => (
						<MemberRow key={m.id} member={m} onChange={refresh} />
					))}
				</div>
			</Panel>

			{pendingInvitations.length > 0 && (
				<div className="mt-6">
					<Panel
						title="Pending Invitations"
						description="Invites that haven't been accepted yet"
					>
						<div className="space-y-1">
							{pendingInvitations.map((inv) => (
								<InvitationRow
									key={inv.id}
									invitation={inv}
									onChange={refresh}
								/>
							))}
						</div>
					</Panel>
				</div>
			)}
		</main>
	);
}

function Panel({
	title,
	description,
	children,
}: {
	title: string;
	description: string;
	children: React.ReactNode;
}) {
	return (
		<section className="island-shell rounded-sm p-6">
			<div className="mb-5">
				<h2 className="text-base font-semibold text-[var(--sea-ink)]">
					{title}
				</h2>
				<p className="mt-1 text-sm text-[var(--sea-ink-soft)]">{description}</p>
			</div>
			{children}
		</section>
	);
}

function initialsOf(name: string): string {
	return name
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((p) => p[0]?.toUpperCase() ?? "")
		.join("");
}

function MemberRow({
	member,
	onChange,
}: {
	member: Member;
	onChange: () => void;
}) {
	const role = member.role as Role | "owner";

	return (
		<div className="flex items-center justify-between rounded-sm px-3 py-3 hover:bg-[var(--surface-strong)]">
			<div className="flex min-w-0 items-center gap-3">
				<Avatar className="size-9">
					{member.user.image && (
						<AvatarImage src={member.user.image} alt={member.user.name} />
					)}
					<AvatarFallback className="text-xs">
						{initialsOf(member.user.name) || "?"}
					</AvatarFallback>
				</Avatar>
				<div className="min-w-0">
					<div className="truncate text-sm font-medium text-[var(--sea-ink)]">
						{member.user.name}
					</div>
					<div className="truncate text-xs text-[var(--sea-ink-soft)]">
						{member.user.email}
					</div>
				</div>
			</div>
			<div className="flex items-center gap-2">
				<RolePill role={role} />
				{role !== "owner" && <MemberMenu member={member} onChange={onChange} />}
			</div>
		</div>
	);
}

function RolePill({ role }: { role: string }) {
	return (
		<span className="rounded-full border border-[var(--line)] bg-[var(--surface-strong)] px-2.5 py-0.5 text-xs font-medium text-[var(--sea-ink-soft)]">
			{role}
		</span>
	);
}

function MemberMenu({
	member,
	onChange,
}: {
	member: Member;
	onChange: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const role = member.role as Role;

	async function setRole(next: Role) {
		if (next === role) return;
		setBusy(true);
		try {
			await updateMemberRole({ data: { memberId: member.id, role: next } });
			onChange();
		} finally {
			setBusy(false);
		}
	}

	async function remove() {
		if (!confirm(`Remove ${member.user.email}?`)) return;
		setBusy(true);
		try {
			await removeMember({ data: { memberIdOrEmail: member.id } });
			onChange();
		} finally {
			setBusy(false);
		}
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="size-7"
					disabled={busy}
					aria-label="Member actions"
				>
					<MoreHorizontal className="size-4" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-[160px]">
				<DropdownMenuLabel className="text-xs text-muted-foreground">
					Change role
				</DropdownMenuLabel>
				<DropdownMenuItem onClick={() => setRole("admin")}>
					Admin {role === "admin" && "✓"}
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => setRole("member")}>
					Member {role === "member" && "✓"}
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem onClick={remove} className="text-red-400">
					Remove from organization
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function InvitationRow({
	invitation,
	onChange,
}: {
	invitation: {
		id: string;
		email: string;
		role: string;
		expiresAt: Date | string;
	};
	onChange: () => void;
}) {
	const [busy, setBusy] = useState(false);
	return (
		<div className="flex items-center justify-between rounded-sm px-3 py-3 hover:bg-[var(--surface-strong)]">
			<div className="min-w-0">
				<div className="truncate text-sm font-medium text-[var(--sea-ink)]">
					{invitation.email}
				</div>
				<div className="mt-0.5 text-xs text-[var(--sea-ink-soft)]">
					{invitation.role} · Expires{" "}
					{new Date(invitation.expiresAt).toLocaleDateString()}
				</div>
			</div>
			<Button
				variant="ghost"
				size="sm"
				disabled={busy}
				onClick={async () => {
					setBusy(true);
					try {
						await cancelInvitation({ data: { invitationId: invitation.id } });
						onChange();
					} finally {
						setBusy(false);
					}
				}}
				className="text-xs text-red-400 hover:text-red-300"
			>
				Cancel
			</Button>
		</div>
	);
}

function InviteForm({ onInvited }: { onInvited: () => void }) {
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const form = useForm({
		defaultValues: { email: "", role: "member" as Role },
		onSubmit: async ({ value }) => {
			setError(null);
			try {
				await inviteMember({
					data: { email: value.email.trim(), role: value.role },
				});
				form.reset();
				setOpen(false);
				onInvited();
			} catch (err) {
				setError((err as Error).message ?? "Failed to send invitation");
			}
		},
	});

	function handleOpenChange(next: boolean) {
		setOpen(next);
		if (!next) {
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
					Invite Member
				</Button>
			</DialogTrigger>
			<DialogContent>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						form.handleSubmit();
					}}
				>
					<DialogHeader>
						<DialogTitle>Invite a member</DialogTitle>
						<DialogDescription>
							We'll email an invitation link. They'll need to sign in to accept.
						</DialogDescription>
					</DialogHeader>

					<div className="my-6 space-y-4">
						<form.Field
							name="email"
							validators={{
								onSubmit: ({ value }) =>
									!value.trim() ? "Email is required" : undefined,
							}}
						>
							{(field) => (
								<label className="block">
									<span className="mb-1 block text-sm font-semibold text-[var(--sea-ink-soft)]">
										Email
									</span>
									<input
										type="email"
										required
										value={field.state.value}
										onChange={(e) => field.handleChange(e.target.value)}
										onBlur={field.handleBlur}
										placeholder="email@example.com"
										disabled={form.state.isSubmitting}
										className="w-full rounded-sm border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-2 text-sm text-[var(--sea-ink)] focus:border-[var(--lagoon-line)] focus:outline-none"
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

						<form.Field name="role">
							{(field) => (
								<label className="block">
									<span className="mb-1 block text-sm font-semibold text-[var(--sea-ink-soft)]">
										Role
									</span>
									<select
										value={field.state.value}
										onChange={(e) => field.handleChange(e.target.value as Role)}
										disabled={form.state.isSubmitting}
										className="w-full rounded-sm border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-2 text-sm text-[var(--sea-ink)]"
									>
										<option value="member">Member</option>
										<option value="admin">Admin</option>
									</select>
								</label>
							)}
						</form.Field>

						{error && <p className="text-xs text-red-400">{error}</p>}
					</div>

					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => handleOpenChange(false)}
						>
							Cancel
						</Button>
						<form.Subscribe
							selector={(state) =>
								[
									state.values.email,
									state.canSubmit,
									state.isSubmitting,
								] as const
							}
						>
							{([email, canSubmit, isSubmitting]) => (
								<Button
									type="submit"
									variant="outline"
									disabled={!email.trim() || !canSubmit || isSubmitting}
									className="border-[var(--lagoon-line)] text-[var(--lagoon-deep)] hover:bg-[var(--lagoon-soft)] hover:text-[var(--lagoon)]"
								>
									{isSubmitting ? "Sending..." : "Send invite"}
								</Button>
							)}
						</form.Subscribe>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
