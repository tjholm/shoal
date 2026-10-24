import { Button } from "@shoal/ui/components/button";
import { Input } from "@shoal/ui/components/input";
import { ShoalGlyph } from "@shoal/ui/components/ShoalMark";
import { Lock } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import type { BackendState, HostFeatures, SettingsView } from "@shoal/client-core/host/api";
import { useHost } from "./host";
import { DIALECT_NAME, hostOf, TOKEN_STORAGE } from "./ui";

/** First run: join this computer to a shoal server. */
export function Setup({ features }: { features: HostFeatures }) {
	const [serverUrl, setServerUrl] = useState("");
	const [token, setToken] = useState("");
	const [found, setFound] = useState<ReadonlyArray<BackendState> | null>(null);
	const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
	const [other, setOther] = useState("");
	const [errors, setErrors] = useState<ReadonlyArray<string>>([]);
	const [saving, setSaving] = useState(false);
	/** What the client already fixed, e.g. the CLI's --server; null when nothing is. */
	const [preset, setPreset] = useState<SettingsView | null | undefined>(undefined);
	const host = useHost();
	const fixed = preset?.fixedBy ?? {};

	useEffect(() => {
		void host.request.getSettings().then((view) => {
			setPreset(view);
			if (view !== null) setServerUrl(view.serverUrl);
		});
		void host.request.detectBackends().then((backends) => {
			const reachable = backends.filter((b) => b.dialect !== null);
			setFound(reachable);
			setChosen(new Set(reachable.map((b) => b.url)));
		});
	}, [host]);

	const toggle = (url: string) =>
		setChosen((current) => {
			const next = new Set(current);
			if (!next.delete(url)) next.add(url);
			return next;
		});

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setSaving(true);
		try {
			const result = await host.request.saveSettings({
				serverUrl,
				token,
				backends: fixed.backends === undefined ? [...chosen, other] : (preset?.backends ?? []),
				name: preset?.name ?? "",
				concurrency: preset?.concurrency ?? 1,
				launchAtLogin: false,
			});
			if (!result.ok) setErrors(result.errors);
		} catch (error) {
			setErrors([error instanceof Error ? error.message : String(error)]);
		} finally {
			setSaving(false);
		}
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
						It serves jobs from the models you run locally{features.tray ? ", and lives in the menu bar once connected" : ""}.
					</p>
				</div>

				<label className="flex flex-col gap-[7px]">
					<span className="text-[13px] font-medium">Server address</span>
					<Input
						value={serverUrl}
						onChange={(e) => setServerUrl(e.target.value)}
						disabled={fixed.serverUrl !== undefined}
						placeholder="https://shoal.example.com"
						className="font-mono"
						autoComplete="off"
					/>
					{fixed.serverUrl !== undefined && <span className="text-xs text-silt">Set by {fixed.serverUrl}</span>}
				</label>
				{fixed.token === undefined ? (
					<label className="flex flex-col gap-[7px]">
						<span className="text-[13px] font-medium">API key</span>
						<Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste an API key" className="font-mono" autoComplete="off" />
						<span className="flex items-center gap-1.5 text-xs text-silt">
							<Lock size={12} aria-hidden="true" />
							Kept in {TOKEN_STORAGE[features.tokenStorage]}, never in your shell history.
						</span>
					</label>
				) : (
					<p className="m-0 flex items-center gap-1.5 text-sm text-mist">
						<Lock size={14} className="text-lumen" aria-hidden="true" />
						API key set by {fixed.token}.
					</p>
				)}

				{fixed.backends === undefined ? (
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
				) : (
					<p className="m-0 text-sm text-mist">
						Backends {preset?.backends.join(", ")}, set by {fixed.backends}.
					</p>
				)}

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
