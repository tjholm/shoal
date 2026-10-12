import { useLiveQuery } from "@tanstack/react-db";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { CopyButton } from "../../components/CopyButton";
import { Fact, Page, TableHead } from "../../components/Page";
import { Button } from "../../components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { authClient, unwrap } from "../../lib/auth-client";
import { workersCollection } from "../../lib/collections";
import { authContextQuery, invitationsQuery, membersQuery } from "../../lib/queries";

export const Route = createFileRoute("/_authed/members")({
	loader: ({ context: { queryClient } }) =>
		Promise.all([
			queryClient.ensureQueryData(membersQuery()),
			queryClient.ensureQueryData(invitationsQuery()),
		]),
	component: Members,
});

type Role = "admin" | "member";

function Members() {
	const { data: members } = useSuspenseQuery(membersQuery());
	const { data: invitations } = useSuspenseQuery(invitationsQuery());
	const { data: auth } = useQuery(authContextQuery());
	const { data: workers } = useLiveQuery((q) => q.from({ worker: workersCollection }));
	const queryClient = useQueryClient();
	const refresh = () => {
		queryClient.invalidateQueries({ queryKey: membersQuery().queryKey });
		queryClient.invalidateQueries({ queryKey: invitationsQuery().queryKey });
	};

	const me = members.find((m) => m.userId === auth?.user.id);
	const canManage = me?.role === "owner" || me?.role === "admin";
	const pending = invitations.filter((i) => i.status === "pending");
	const names = new Map(members.map((m) => [m.userId, m.user.name]));

	return (
		<Page
			title="Members"
			stats={
				<>
					<Fact value={members.length}>{members.length === 1 ? "member" : "members"}</Fact>
					<Fact value={pending.length}>pending</Fact>
					<Fact value={workers?.length ?? 0}>
						{workers?.length === 1 ? "worker" : "workers"} in the org
					</Fact>
				</>
			}
		>
			{canManage && <InviteForm orgName={auth?.activeOrg?.name} onInvited={refresh} />}

			<section
				aria-label="Members"
				className="rise-in overflow-hidden rounded-md border border-line bg-shelf"
			>
				<div className="overflow-x-auto">
					<div className="min-w-[560px]">
						<TableHead columns={MEMBER_COLUMNS}>
							<span>Member</span>
							<span>Role</span>
							<span className="text-right">Joined</span>
							<span />
						</TableHead>
						{members.map((m) => (
							<MemberRow
								key={m.id}
								member={m}
								isYou={m.userId === auth?.user.id}
								canManage={canManage}
								onChange={refresh}
							/>
						))}
					</div>
				</div>
			</section>

			{pending.length > 0 && (
				<section aria-label="Pending invites" className="flex flex-col gap-2.5">
					<h2 className="label">Pending</h2>
					{pending.map((invitation) => (
						<PendingInvite
							key={invitation.id}
							invitation={invitation}
							invitedBy={names.get(invitation.inviterId)}
							canManage={canManage}
							onChange={refresh}
						/>
					))}
				</section>
			)}

			<Roles />
		</Page>
	);
}

function InviteForm({
	orgName,
	onInvited,
}: {
	orgName: string | undefined;
	onInvited: () => void;
}) {
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<Role>("member");
	const [sending, setSending] = useState(false);
	const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

	const invite = async (e: React.FormEvent) => {
		e.preventDefault();
		const address = email.trim();
		if (!address) return;
		setSending(true);
		setResult(null);
		try {
			await unwrap(authClient.organization.inviteMember({ email: address, role }));
			setResult({ ok: true, text: `✓ Invite sent to ${address}` });
			setEmail("");
			onInvited();
		} catch (err) {
			setResult({ ok: false, text: (err as Error).message ?? "Couldn't send the invite." });
		} finally {
			setSending(false);
		}
	};

	return (
		<form
			aria-label="Invite"
			onSubmit={invite}
			className="rise-in flex flex-col gap-3 rounded-md border border-line bg-shelf px-[18px] py-4"
		>
			<div className="flex flex-wrap items-end gap-3">
				<div className="flex min-w-0 flex-[999_1_280px] flex-col gap-1.5">
					<label htmlFor="invite-email" className="text-[13px] font-medium text-foam">
						Invite by email
					</label>
					<input
						id="invite-email"
						type="email"
						required
						value={email}
						onChange={(e) => setEmail(e.target.value)}
						placeholder="name@company.com"
						className="h-10 rounded-sm border border-input bg-trench px-3 font-mono text-[13px] text-foam placeholder:text-silt"
					/>
				</div>
				<div className="flex flex-[1_1_160px] flex-col gap-1.5">
					<label htmlFor="invite-role" className="text-[13px] font-medium text-foam">
						Role
					</label>
					<select
						id="invite-role"
						value={role}
						onChange={(e) => setRole(e.target.value as Role)}
						className="h-10 rounded-sm border border-input bg-trench pl-3 text-sm text-foam"
					>
						<option value="member">Member</option>
						<option value="admin">Admin</option>
					</select>
				</div>
				<Button type="submit" disabled={sending}>
					{sending ? "Sending…" : "Send invite"}
				</Button>
			</div>
			{result ? (
				<span className={`font-mono text-xs ${result.ok ? "text-lumen" : "text-coral"}`}>
					{result.text}
				</span>
			) : (
				<span className="text-xs text-silt">
					They get a link to join {orgName ?? "this organization"}. Workers and keys belong to the
					org, not to them.
				</span>
			)}
		</form>
	);
}

const MEMBER_COLUMNS = "minmax(0,2.2fr) 140px 110px 40px";

interface Member {
	id: string;
	userId: string;
	role: string;
	createdAt: Date | string;
	user: { name: string; email: string; image?: string | null };
}

function MemberRow({
	member,
	isYou,
	canManage,
	onChange,
}: {
	member: Member;
	isYou: boolean;
	canManage: boolean;
	onChange: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const isOwner = member.role === "owner";
	const editable = canManage && !isOwner && !isYou;

	const run = async (action: () => Promise<unknown>) => {
		setBusy(true);
		try {
			await action();
			onChange();
		} finally {
			setBusy(false);
		}
	};

	return (
		<div
			className="grid items-center gap-4 border-b border-reef px-[18px] py-3.5 last:border-b-0"
			style={{ gridTemplateColumns: MEMBER_COLUMNS }}
		>
			<span className="flex min-w-0 items-center gap-3">
				<span
					aria-hidden="true"
					className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-sm border border-line-strong bg-reef font-mono text-xs text-foam uppercase"
				>
					{member.user.image ? (
						<img src={member.user.image} alt="" className="size-full object-cover" />
					) : (
						member.user.name.trim().charAt(0) || "?"
					)}
				</span>
				<span className="flex min-w-0 flex-col gap-0.5">
					<span className="flex items-center gap-2 text-sm font-medium text-foam">
						<span className="truncate">{member.user.name}</span>
						{isYou && (
							<span className="rounded-xs border border-line-strong px-[5px] py-px font-mono text-[10.5px] text-mist">
								you
							</span>
						)}
					</span>
					<span className="truncate font-mono text-xs text-silt">{member.user.email}</span>
				</span>
			</span>
			<span>
				{editable ? (
					<>
						<label htmlFor={`role-${member.id}`} className="sr-only">
							Role for {member.user.name}
						</label>
						<select
							id={`role-${member.id}`}
							value={member.role}
							disabled={busy}
							onChange={(e) =>
								run(() =>
									unwrap(
										authClient.organization.updateMemberRole({
											memberId: member.id,
											role: e.target.value as Role,
										}),
									),
								)
							}
							className="h-8 rounded-sm border border-input bg-trench pl-2.5 text-[13px] text-foam"
						>
							<option value="member">Member</option>
							<option value="admin">Admin</option>
						</select>
					</>
				) : (
					<span
						className={`inline-flex h-6 items-center rounded-xs border px-2 font-mono text-xs ${
							isOwner ? "border-lumen-edge bg-lumen-wash text-lumen" : "border-line-strong text-mist"
						}`}
					>
						{member.role}
					</span>
				)}
			</span>
			<span className="text-right font-mono text-xs text-mist">{formatAgo(member.createdAt)}</span>
			<span className="flex justify-end">
				{editable && (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<button
								type="button"
								aria-label={`More actions for ${member.user.name}`}
								disabled={busy}
								className="flex size-8 items-center justify-center rounded-sm text-mist hover:bg-reef hover:text-foam"
							>
								<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
									<circle cx="5" cy="10" r="1.4" />
									<circle cx="10" cy="10" r="1.4" />
									<circle cx="15" cy="10" r="1.4" />
								</svg>
							</button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem
								className="text-coral"
								onClick={() => {
									if (!confirm(`Remove ${member.user.email} from the organization?`)) return;
									run(() =>
										unwrap(authClient.organization.removeMember({ memberIdOrEmail: member.id })),
									);
								}}
							>
								Remove from org
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				)}
			</span>
		</div>
	);
}

interface Invitation {
	id: string;
	email: string;
	role: string;
	expiresAt: Date | string;
	inviterId: string;
}

function PendingInvite({
	invitation,
	invitedBy,
	canManage,
	onChange,
}: {
	invitation: Invitation;
	invitedBy: string | undefined;
	canManage: boolean;
	onChange: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const link = `${window.location.origin}/accept-invitation/${invitation.id}`;
	const expiresIn = new Date(invitation.expiresAt).getTime() - Date.now();

	return (
		<div className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-md border border-dashed border-line-strong px-[18px] py-3">
			<span className="inline-flex h-[22px] items-center gap-1.5 rounded-xs border border-amber-edge bg-amber-wash px-2 font-mono text-[11px] text-amber">
				◇ invited
			</span>
			<span className="font-mono text-[13px] text-foam">{invitation.email}</span>
			<span className="text-xs text-mist">
				{invitation.role}
				{invitedBy && ` · by ${invitedBy}`} ·{" "}
				{expiresIn > 0 ? `expires in ${formatSpan(expiresIn)}` : "expired"}
			</span>
			<div className="grow" />
			<span className="flex items-center gap-1 text-[13px] text-mist">
				Copy link
				<CopyButton value={link} label="Copy invite link" />
			</span>
			{canManage && (
				<Button
					variant="ghost"
					size="sm"
					disabled={busy}
					className="text-coral hover:text-coral"
					onClick={async () => {
						setBusy(true);
						try {
							await unwrap(
								authClient.organization.cancelInvitation({ invitationId: invitation.id }),
							);
							onChange();
						} finally {
							setBusy(false);
						}
					}}
				>
					Cancel
				</Button>
			)}
		</div>
	);
}

/** What each role may do, matching the access control the API enforces. */
function Roles() {
	const roles = [
		{
			name: "owner",
			tone: "text-lumen",
			text: "Everything an admin can do, plus delete the organization.",
		},
		{
			name: "admin",
			tone: "text-foam",
			text: "Invite and remove members, change roles, create and revoke API keys.",
		},
		{
			name: "member",
			tone: "text-foam",
			text: "See the fleet and usage. Uses keys an admin creates to call the API or run workers.",
		},
	];
	return (
		<section
			aria-label="Roles"
			className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-px overflow-hidden rounded-md border border-line bg-line"
		>
			{roles.map((role) => (
				<div key={role.name} className="flex flex-col gap-2 bg-trench px-[18px] py-4">
					<span className={`font-mono text-xs ${role.tone}`}>{role.name}</span>
					<span className="text-[13px] leading-[1.55] text-mist">{role.text}</span>
				</div>
			))}
		</section>
	);
}

function formatSpan(ms: number): string {
	const hours = Math.floor(ms / 3_600_000);
	if (hours < 24) return `${Math.max(1, hours)}h`;
	return `${Math.floor(hours / 24)}d`;
}

function formatAgo(date: Date | string): string {
	return `${formatSpan(Math.max(0, Date.now() - new Date(date).getTime()))} ago`;
}
