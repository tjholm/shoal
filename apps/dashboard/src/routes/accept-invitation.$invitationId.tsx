import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { authClient } from "../lib/auth-client";
import type { InvitationPublicInfo } from "@shoal/contracts";
import { invitationQuery, sessionQuery } from "../lib/queries";

export const Route = createFileRoute("/accept-invitation/$invitationId")({
	loader: async ({ params, context: { queryClient } }) => {
		const [info, session] = await Promise.all([
			queryClient.ensureQueryData(invitationQuery(params.invitationId)),
			queryClient.ensureQueryData(sessionQuery()),
		]);
		return {
			info,
			sessionEmail: session?.user.email ?? null,
		};
	},
	component: AcceptInvitation,
});

function AcceptInvitation() {
	const { invitationId } = Route.useParams();
	const { info, sessionEmail } = Route.useLoaderData();

	if (info.status !== "pending") return <TerminalState info={info} />;

	const signedIn = sessionEmail !== null;
	const emailsMatch =
		signedIn &&
		info.email !== null &&
		sessionEmail.toLowerCase() === info.email.toLowerCase();

	if (!signedIn)
		return <SignedOutCTA invitationId={invitationId} info={info} />;
	if (!emailsMatch)
		return <WrongAccount info={info} sessionEmail={sessionEmail} />;
	return <AcceptDecline invitationId={invitationId} info={info} />;
}

function Shell({ children }: { children: React.ReactNode }) {
	return (
		<main className="page-wrap px-4 pb-8 pt-12">
			<section className="island-shell rise-in mx-auto max-w-md p-8">
				<p className="island-kicker mb-2">Invitation</p>
				{children}
			</section>
		</main>
	);
}

function InviteSummary({ info }: { info: InvitationPublicInfo }) {
	if (!info.organizationName) return null;
	const inviter = info.inviterName ?? info.inviterEmail ?? "Someone";
	return (
		<p className="mb-6 text-sm text-[var(--sea-ink-soft)]">
			<span className="font-medium text-[var(--sea-ink)]">{inviter}</span>{" "}
			invited{" "}
			<span className="font-medium text-[var(--sea-ink)]">{info.email}</span> to
			join{" "}
			<span className="font-medium text-[var(--sea-ink)]">
				{info.organizationName}
			</span>
			{info.role ? ` as ${info.role}` : ""} on Shoal.
		</p>
	);
}

function SignedOutCTA({
	invitationId,
	info,
}: {
	invitationId: string;
	info: InvitationPublicInfo;
}) {
	const redirect = `/accept-invitation/${invitationId}`;

	return (
		<Shell>
			<h1 className="display-title mb-2 text-2xl text-[var(--sea-ink)]">
				Join an organization
			</h1>
			<InviteSummary info={info} />
			<p className="mb-6 text-sm text-[var(--sea-ink-soft)]">
				Sign in to accept, or create an account with this email if you don't
				have one yet.
			</p>
			<div className="flex gap-2">
				<Link
					to="/sign-in"
					search={{ redirect }}
					className="rounded-sm border border-[var(--lagoon-line)] bg-[var(--lagoon-soft)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] hover:bg-[var(--lagoon-line)]"
				>
					Sign in to accept
				</Link>
				<Link
					to="/sign-up"
					search={info.email ? { redirect, email: info.email } : { redirect }}
					className="rounded-sm border border-[var(--line)] px-4 py-2 text-sm text-[var(--sea-ink-soft)] hover:bg-[var(--surface)]"
				>
					Create account
				</Link>
			</div>
		</Shell>
	);
}

function WrongAccount({
	info,
	sessionEmail,
}: {
	info: InvitationPublicInfo;
	sessionEmail: string;
}) {
	const navigate = useNavigate();
	const [working, setWorking] = useState(false);

	async function signOutAndRetry() {
		setWorking(true);
		await authClient.signOut();
		navigate({
			to: "/sign-in",
			search: { redirect: window.location.pathname },
		});
	}

	return (
		<Shell>
			<h1 className="display-title mb-2 text-2xl text-[var(--sea-ink)]">
				Wrong account
			</h1>
			<p className="mb-6 text-sm text-[var(--sea-ink-soft)]">
				This invitation is for{" "}
				<span className="font-medium text-[var(--sea-ink)]">{info.email}</span>,
				but you're signed in as{" "}
				<span className="font-medium text-[var(--sea-ink)]">
					{sessionEmail}
				</span>
				. Sign out and sign back in with the invited address to continue.
			</p>
			<button
				type="button"
				onClick={signOutAndRetry}
				disabled={working}
				className="rounded-sm border border-[var(--lagoon-line)] bg-[var(--lagoon-soft)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] hover:bg-[var(--lagoon-line)] disabled:opacity-50"
			>
				{working ? "Signing out..." : "Sign out"}
			</button>
		</Shell>
	);
}

function AcceptDecline({
	invitationId,
	info,
}: {
	invitationId: string;
	info: InvitationPublicInfo;
}) {
	const navigate = useNavigate();
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function accept() {
		setSubmitting(true);
		setError(null);
		const { data, error: acceptError } =
			await authClient.organization.acceptInvitation({ invitationId });
		if (acceptError || !data) {
			setError(acceptError?.message ?? "Failed to accept invitation");
			setSubmitting(false);
			return;
		}
		if (data.invitation?.organizationId) {
			await authClient.organization.setActive({
				organizationId: data.invitation.organizationId,
			});
		}
		navigate({ to: "/" });
	}

	async function reject() {
		setSubmitting(true);
		setError(null);
		const { error: rejectError } =
			await authClient.organization.rejectInvitation({ invitationId });
		if (rejectError) {
			setError(rejectError.message ?? "Failed to reject invitation");
			setSubmitting(false);
			return;
		}
		navigate({ to: "/" });
	}

	return (
		<Shell>
			<h1 className="display-title mb-2 text-2xl text-[var(--sea-ink)]">
				Join an organization
			</h1>
			<InviteSummary info={info} />
			<p className="mb-6 text-sm text-[var(--sea-ink-soft)]">
				Accept this invitation to join. Once you accept, it'll become your
				active organization.
			</p>

			<div className="flex gap-2">
				<button
					type="button"
					onClick={accept}
					disabled={submitting}
					className="rounded-sm border border-[var(--lagoon-line)] bg-[var(--lagoon-soft)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] hover:bg-[var(--lagoon-line)] disabled:opacity-50"
				>
					{submitting ? "Working..." : "Accept"}
				</button>
				<button
					type="button"
					onClick={reject}
					disabled={submitting}
					className="rounded-sm border border-[var(--line)] px-4 py-2 text-sm text-[var(--sea-ink-soft)] hover:bg-[var(--surface)] disabled:opacity-50"
				>
					Decline
				</button>
			</div>

			{error && <p className="mt-4 text-sm text-coral">{error}</p>}
		</Shell>
	);
}

function TerminalState({ info }: { info: InvitationPublicInfo }) {
	const headline = {
		not_found: "Invitation not found",
		expired: "Invitation expired",
		accepted: "Invitation already accepted",
		rejected: "Invitation declined",
		canceled: "Invitation canceled",
		pending: "",
	}[info.status];

	const body = {
		not_found:
			"We can't find an invitation with that ID. Check the link, or ask the person who invited you to send a new one.",
		expired:
			"This invitation has expired. Ask the person who invited you to send a new one.",
		accepted:
			"You've already accepted this invitation. Sign in to access the organization.",
		rejected:
			"This invitation was declined. Ask the person who invited you to send a new one if you've changed your mind.",
		canceled:
			"This invitation was canceled by an admin. Ask them to send a new one if you should still have access.",
		pending: "",
	}[info.status];

	return (
		<Shell>
			<h1 className="display-title mb-2 text-2xl text-[var(--sea-ink)]">
				{headline}
			</h1>
			<p className="mb-6 text-sm text-[var(--sea-ink-soft)]">{body}</p>
			<Link to="/" className="text-link text-sm font-semibold">
				Go home
			</Link>
		</Shell>
	);
}
