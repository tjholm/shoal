import { Button } from "@shoal/ui/components/button";
import { Input } from "@shoal/ui/components/input";
import { ShoalGlyph } from "@shoal/ui/components/ShoalMark";
import { type FormEvent, useState } from "react";
import { signIn } from "./http";

/** Asks for the access token the worker printed when it started. */
export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
	const [token, setToken] = useState("");
	const [wrong, setWrong] = useState(false);
	const [checking, setChecking] = useState(false);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setChecking(true);
		const ok = await signIn(token.trim());
		setChecking(false);
		if (ok) onSignedIn();
		else setWrong(true);
	};

	return (
		<main className="flex min-h-screen items-center justify-center bg-abyss px-10 text-foam">
			<form onSubmit={submit} noValidate className="flex w-[380px] flex-col gap-5">
				<div className="flex flex-col items-center gap-3 text-center">
					<span className="flex text-mist">
						<ShoalGlyph size={48} />
					</span>
					<h1 className="m-0 text-[22px] font-semibold tracking-[-0.02em]">Sign in to this worker</h1>
					<p className="m-0 text-sm leading-normal text-mist">
						Use the access token from <code className="font-mono">shoal worker start --ui</code>'s output, or the{" "}
						<code className="font-mono">ui-token</code> file in the worker's state folder.
					</p>
				</div>
				<label className="flex flex-col gap-[7px]">
					<span className="text-[13px] font-medium">Access token</span>
					<Input type="password" value={token} onChange={(e) => setToken(e.target.value)} className="font-mono" autoComplete="off" />
				</label>
				{wrong && (
					<p role="alert" className="m-0 text-sm text-coral">
						That token isn't right.
					</p>
				)}
				<Button type="submit" disabled={checking || token.trim() === ""}>
					{checking ? "Checking…" : "Sign in"}
				</Button>
			</form>
		</main>
	);
}
