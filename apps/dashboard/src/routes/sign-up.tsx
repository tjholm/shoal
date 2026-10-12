import { useForm } from "@tanstack/react-form";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { authClient } from "../lib/auth-client";
import { TextField } from "../lib/form";
import { serverConfigQuery } from "../lib/queries";

export const Route = createFileRoute("/sign-up")({
	validateSearch: (
		search: Record<string, unknown>,
	): { redirect?: string; email?: string } => {
		const out: { redirect?: string; email?: string } = {};
		if (typeof search.redirect === "string") out.redirect = search.redirect;
		if (typeof search.email === "string") out.email = search.email;
		return out;
	},
	loader: async ({ context: { queryClient } }) => ({
		allowed: (await queryClient.ensureQueryData(serverConfigQuery())).signupAllowed,
	}),
	component: SignUp,
});

function SignUp() {
	const { allowed } = Route.useLoaderData();
	const { redirect, email } = Route.useSearch();
	const inviteFlow = redirect?.startsWith("/accept-invitation/") ?? false;
	// Invited users bypass the "signups closed" gate — the server still verifies
	// a pending invitation exists for the submitted email.
	if (!allowed && !inviteFlow) return <SignupClosed />;
	return (
		<SignUpForm
			redirect={redirect}
			prefilledEmail={email}
			inviteFlow={inviteFlow}
		/>
	);
}

function SignupClosed() {
	return (
		<main className="page-wrap px-4 pb-8 pt-14">
			<section className="island-shell rise-in mx-auto max-w-md p-8 text-center">
				<p className="island-kicker mb-2">Sign Up</p>
				<h1 className="display-title mb-4 text-2xl text-[var(--sea-ink)]">
					Signups are closed
				</h1>
				<p className="text-sm text-[var(--sea-ink-soft)]">
					This Shoal deployment isn't accepting new public registrations. Ask an
					admin for an invitation, or{" "}
					<Link to="/sign-in" search={{}} className="text-link font-semibold">
						sign in
					</Link>{" "}
					if you already have an account.
				</p>
			</section>
		</main>
	);
}

function SignUpForm({
	redirect,
	prefilledEmail,
	inviteFlow,
}: {
	redirect?: string;
	prefilledEmail?: string;
	inviteFlow: boolean;
}) {
	const navigate = useNavigate();
	const [error, setError] = useState<string | null>(null);

	const form = useForm({
		defaultValues: {
			name: "",
			email: prefilledEmail ?? "",
			password: "",
			orgName: "",
		},
		onSubmit: async ({ value }) => {
			setError(null);

			const { error: signUpError } = await authClient.signUp.email({
				email: value.email,
				password: value.password,
				name: value.name,
			});
			if (signUpError) {
				setError(signUpError.message ?? "Sign up failed");
				return;
			}

			// Invited users don't create an org — accepting the invitation joins
			// them to one that already exists, and the accept handler sets it active.
			if (!inviteFlow) {
				const { data: org, error: orgError } =
					await authClient.organization.create({
						name: value.orgName,
						slug: value.orgName.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
					});
				if (orgError || !org) {
					setError(`Account created but org failed: ${orgError?.message}`);
					return;
				}

				await authClient.organization.setActive({ organizationId: org.id });
			}

			navigate({ to: redirect?.startsWith("/") ? redirect : "/" });
		},
	});

	return (
		<main className="page-wrap px-4 pb-8 pt-14">
			<section className="island-shell rise-in mx-auto max-w-md p-8">
				<p className="island-kicker mb-2">Sign Up</p>
				<h1 className="display-title mb-6 text-2xl text-[var(--sea-ink)]">
					Create your account
				</h1>

				<form
					onSubmit={(e) => {
						e.preventDefault();
						form.handleSubmit();
					}}
					className="space-y-4"
				>
					<form.Field
						name="name"
						validators={{
							onSubmit: ({ value }) =>
								!value ? "Name is required" : undefined,
						}}
					>
						{(field) => <TextField field={field} label="Name" required />}
					</form.Field>
					<form.Field
						name="email"
						validators={{
							onSubmit: ({ value }) =>
								!value ? "Email is required" : undefined,
						}}
					>
						{(field) => (
							<TextField field={field} label="Email" type="email" required />
						)}
					</form.Field>
					<form.Field
						name="password"
						validators={{
							onSubmit: ({ value }) =>
								value.length < 8
									? "Password must be at least 8 characters"
									: undefined,
						}}
					>
						{(field) => (
							<TextField
								field={field}
								label="Password"
								type="password"
								required
							/>
						)}
					</form.Field>
					{!inviteFlow && (
						<form.Field
							name="orgName"
							validators={{
								onSubmit: ({ value }) =>
									!value ? "Organization name is required" : undefined,
							}}
						>
							{(field) => (
								<TextField field={field} label="Organization name" required />
							)}
						</form.Field>
					)}

					{error && (
						<p className="rounded-sm border border-coral-edge bg-coral-wash px-3 py-2 text-sm text-coral">
							{error}
						</p>
					)}

					<form.Subscribe
						selector={(state) => [state.canSubmit, state.isSubmitting] as const}
					>
						{([canSubmit, isSubmitting]) => (
							<button
								type="submit"
								disabled={!canSubmit || isSubmitting}
								className="w-full rounded-sm border border-[var(--lagoon-line)] bg-[var(--lagoon-soft)] px-5 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] transition hover:bg-[var(--lagoon-line)] disabled:opacity-50"
							>
								{isSubmitting ? "Creating..." : "Sign up"}
							</button>
						)}
					</form.Subscribe>
				</form>

				<p className="mt-4 text-center text-sm text-[var(--sea-ink-soft)]">
					Already have an account?{" "}
					<Link
						to="/sign-in"
						search={redirect ? { redirect } : {}}
						className="text-link font-semibold"
					>
						Sign in
					</Link>
				</p>
			</section>
		</main>
	);
}
