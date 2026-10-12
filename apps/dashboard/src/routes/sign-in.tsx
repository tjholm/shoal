import { useForm } from "@tanstack/react-form";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { authClient } from "../lib/auth-client";
import { TextField } from "../lib/form";
import { safeRedirect } from "../lib/safe-redirect";
import { serverConfigQuery } from "../lib/queries";

export const Route = createFileRoute("/sign-in")({
	validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
		const redirect =
			typeof search.redirect === "string" ? search.redirect : undefined;
		return redirect ? { redirect } : {};
	},
	loader: async ({ context: { queryClient } }) => ({
		allowed: (await queryClient.ensureQueryData(serverConfigQuery())).signupAllowed,
	}),
	component: SignIn,
});

function SignIn() {
	const { allowed: signupAllowed } = Route.useLoaderData();
	const { redirect } = Route.useSearch();
	const navigate = useNavigate();
	const [error, setError] = useState<string | null>(null);

	const form = useForm({
		defaultValues: { email: "", password: "" },
		onSubmit: async ({ value }) => {
			setError(null);
			const { error: signInError } = await authClient.signIn.email({
				email: value.email,
				password: value.password,
			});
			if (signInError) {
				setError(signInError.message ?? "Sign in failed");
				return;
			}

			// Make sure an active org is set so org-scoped operations work
			const { data: orgs } = await authClient.organization.list();
			if (orgs && orgs.length > 0) {
				await authClient.organization.setActive({ organizationId: orgs[0].id });
			}

			navigate({ to: safeRedirect(redirect) });
		},
	});

	return (
		<main className="page-wrap px-4 pb-8 pt-14">
			<section className="island-shell rise-in mx-auto max-w-md p-8">
				<p className="island-kicker mb-2">Sign In</p>
				<h1 className="display-title mb-6 text-2xl text-[var(--sea-ink)]">
					Welcome back
				</h1>

				<form
					onSubmit={(e) => {
						e.preventDefault();
						form.handleSubmit();
					}}
					className="space-y-4"
				>
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
								!value ? "Password is required" : undefined,
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
								{isSubmitting ? "Signing in..." : "Sign in"}
							</button>
						)}
					</form.Subscribe>
				</form>

				{signupAllowed && (
					<p className="mt-4 text-center text-sm text-[var(--sea-ink-soft)]">
						Don't have an account?{" "}
						<Link
							to="/sign-up"
							search={redirect ? { redirect } : undefined}
							className="text-link font-semibold"
						>
							Sign up
						</Link>
					</p>
				)}
			</section>
		</main>
	);
}
