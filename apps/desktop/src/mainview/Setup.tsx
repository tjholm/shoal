import { Button } from "@shoal/ui/components/button";
import { Input } from "@shoal/ui/components/input";
import { ShoalGlyph } from "@shoal/ui/components/ShoalMark";
import { Lock } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import type { BackendState } from "../shared/rpc";
import { rpc } from "./rpc";
import { DIALECT_NAME, hostOf } from "./ui";

/** First run: join this computer to a shoal server. */
export function Setup() {
	const [serverUrl, setServerUrl] = useState("");
	const [token, setToken] = useState("");
	const [found, setFound] = useState<ReadonlyArray<BackendState> | null>(null);
	const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
	const [other, setOther] = useState("");
	const [errors, setErrors] = useState<ReadonlyArray<string>>([]);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		void rpc.request.detectBackends().then((backends) => {
			const reachable = backends.filter((b) => b.dialect !== null);
			setFound(reachable);
			setChosen(new Set(reachable.map((b) => b.url)));
		});
	}, []);

	const toggle = (url: string) =>
		setChosen((current) => {
			const next = new Set(current);
			if (!next.delete(url)) next.add(url);
			return next;
		});

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setSaving(true);
		const result = await rpc.request.saveSettings({
			serverUrl,
			token,
			backends: [...chosen, other],
			name: "",
			concurrency: 1,
			launchAtLogin: false,
		});
		setSaving(false);
		if (!result.ok) setErrors(result.errors);
	};

	return (
		<main className="flex min-h-screen justify-center bg-abyss px-10 py-12 text-foam">
			<form onSubmit={submit} noValidate className="flex w-[460px] flex-col gap-6">
				<div className="flex flex-col items-center gap-3.5 text-center">
					<span className="flex text-mist">
						<ShoalGlyph size={56} />
					</span>
					<h1 className="m-0 text-[26px] font-semibold tracking-[-0.02em]">Join this computer to your shoal</h1>
					<p className="m-0 text-sm leading-normal text-mist">
						It serves jobs from the models you run locally, and lives in the menu bar once connected.
					</p>
				</div>

				<label className="flex flex-col gap-[7px]">
					<span className="text-[13px] font-medium">Server address</span>
					<Input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="https://shoal.example.com" className="font-mono" autoComplete="off" />
				</label>
				<label className="flex flex-col gap-[7px]">
					<span className="text-[13px] font-medium">API key</span>
					<Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste an API key" className="font-mono" autoComplete="off" />
					<span className="flex items-center gap-1.5 text-xs text-silt">
						<Lock size={12} aria-hidden="true" />
						Kept in your system's credential store, never in a file or your shell history.
					</span>
				</label>

				<fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
					<legend className="pb-[7px] text-[13px] font-medium">Backends found on this computer</legend>
					{found === null && <p className="m-0 text-sm text-silt">Looking for backends on this computer…</p>}
					{found?.length === 0 && <p className="m-0 text-sm text-silt">None found on the usual ports. Add a URL below.</p>}
					{found?.map((backend) => (
						<label
							key={backend.url}
							className={`flex items-center gap-3 rounded-[9px] border px-3.5 py-[11px] ${chosen.has(backend.url) ? "border-lumen-edge bg-lumen-wash" : "border-line bg-shelf"}`}
						>
							<input type="checkbox" checked={chosen.has(backend.url)} onChange={() => toggle(backend.url)} className="size-4 accent-[var(--signal-lumen)]" />
							<span className="flex flex-1 flex-col gap-0.5">
								<span className="text-[13px]">{backend.dialect ? DIALECT_NAME[backend.dialect] : "Backend"}</span>
								<span className="font-mono text-xs text-mist">
									{hostOf(backend.url)} · {backend.models.length} models
								</span>
							</span>
						</label>
					))}
					<Input value={other} onChange={(e) => setOther(e.target.value)} placeholder="Another backend URL (optional)" className="font-mono" autoComplete="off" />
				</fieldset>

				{errors.length > 0 && (
					<ul role="alert" className="m-0 flex list-none flex-col gap-1 p-0 text-sm text-coral">
						{errors.map((error) => (
							<li key={error}>{error}</li>
						))}
					</ul>
				)}

				<Button type="submit" size="lg" disabled={saving}>
					{saving ? "Connecting…" : "Connect"}
				</Button>
			</form>
		</main>
	);
}
