import { Button } from "@shoal/ui/components/button";
import { Input } from "@shoal/ui/components/input";
import { Lock, Minus, Plus, X } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useId, useState } from "react";
import type { SettingsView, WorkerState } from "../shared/rpc";
import { BackendChip } from "./Models";
import { rpc } from "./rpc";
import { Body, Card, DIALECT_NAME, Empty, PageTitle, SectionTitle } from "./ui";

let nextRowId = 0;
const row = (value: string) => ({ id: nextRowId++, value });

export function Settings({ state }: { state: WorkerState }) {
	const [saved, setSaved] = useState<SettingsView | null | undefined>(undefined);
	// Bumped to rebuild the form from the saved settings.
	const [version, setVersion] = useState(0);

	useEffect(() => {
		void rpc.request.getSettings().then(setSaved);
	}, [version]);

	// The form reads `saved` only when it mounts, so it mustn't remount until
	// the fresh settings arrive.
	const reload = () => {
		setSaved(undefined);
		setVersion((v) => v + 1);
	};

	// Wait for the saved settings so the form starts from them, not blanks.
	if (saved === undefined || saved === null) return null;
	return <SettingsForm key={version} saved={saved} state={state} onReload={reload} />;
}

function SettingsForm({ saved, state, onReload }: { saved: SettingsView; state: WorkerState; onReload: () => void }) {
	const [serverUrl, setServerUrl] = useState(saved.serverUrl);
	const [replacingToken, setReplacingToken] = useState(!saved.hasToken);
	const [token, setToken] = useState("");
	const [name, setName] = useState(saved.name);
	const [backends, setBackends] = useState(() => saved.backends.map(row));
	const [concurrency, setConcurrency] = useState(saved.concurrency);
	const [launchAtLogin, setLaunchAtLogin] = useState(saved.launchAtLogin);
	const [errors, setErrors] = useState<ReadonlyArray<string>>([]);
	const [saving, setSaving] = useState(false);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setSaving(true);
		const result = await rpc.request.saveSettings({
			serverUrl,
			token: replacingToken ? token : "",
			backends: backends.map((b) => b.value),
			name,
			concurrency,
			launchAtLogin,
		});
		setSaving(false);
		if (result.ok) onReload();
		else setErrors(result.errors);
	};

	return (
		<form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
			<Body>
				<PageTitle>Settings</PageTitle>
				<section className="flex flex-col gap-3">
					<SectionTitle>Server</SectionTitle>
					<div className="grid grid-cols-[130px_minmax(0,1fr)] items-center gap-x-4 gap-y-3">
						<Field label="Server address">
							{(id) => (
								<Input id={id} value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} className="font-mono" autoComplete="off" />
							)}
						</Field>
						<Field label="API key">
							{(id) =>
								replacingToken ? (
									<div className="flex items-center gap-2.5">
										<Input
											id={id}
											type="password"
											value={token}
											onChange={(e) => setToken(e.target.value)}
											placeholder="An API key from the shoal dashboard"
											className="font-mono"
											autoComplete="off"
										/>
										{saved.hasToken && (
											<Button type="button" variant="outline" size="sm" onClick={() => setReplacingToken(false)}>
												Keep saved
											</Button>
										)}
									</div>
								) : (
									<div className="flex items-center gap-2.5">
										<div id={id} className="flex h-10 flex-1 items-center gap-2 rounded-sm border border-line bg-trench px-3 text-[13px] text-mist">
											<Lock size={14} className="text-lumen" aria-hidden="true" />
											Saved in your system's credential store
										</div>
										<Button type="button" variant="outline" size="sm" onClick={() => setReplacingToken(true)}>
											Replace…
										</Button>
									</div>
								)
							}
						</Field>
						<Field label="Worker name">
							{(id) => (
								<Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="Keep the name set in shoal" autoComplete="off" />
							)}
						</Field>
					</div>
				</section>

				<section className="flex flex-col gap-3">
					<div className="flex items-center justify-between">
						<SectionTitle>Backends</SectionTitle>
						<Button type="button" variant="outline" size="xs" onClick={() => setBackends((rows) => [...rows, row("")])}>
							<Plus aria-hidden="true" />
							Add backend
						</Button>
					</div>
					{backends.length === 0 ? (
						<Empty>No backends. Add one above.</Empty>
					) : (
						<Card>
							{backends.map((backend, index) => {
								const health = state.backends.find((b) => b.url === backend.value.trim().replace(/\/$/, ""));
								return (
									<div key={backend.id} className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0">
										<span className="w-3.5 font-mono text-[11px] text-silt">{index + 1}</span>
										<div className="flex min-w-0 flex-1 flex-col gap-1">
											<Input
												aria-label={`Backend ${index + 1}`}
												value={backend.value}
												onChange={(e) =>
													setBackends((rows) => rows.map((r) => (r.id === backend.id ? { ...r, value: e.target.value } : r)))
												}
												placeholder="http://localhost:11434"
												className="h-8 font-mono"
												autoComplete="off"
											/>
											{health?.dialect && (
												<span className="text-xs text-mist">
													{DIALECT_NAME[health.dialect]} · {health.models.length} models · {health.loaded.length} loaded
												</span>
											)}
										</div>
										{health && <BackendChip backend={health} />}
										<Button
											type="button"
											variant="ghost"
											size="icon-sm"
											aria-label={`Remove backend ${index + 1}`}
											onClick={() => setBackends((rows) => rows.filter((r) => r.id !== backend.id))}
										>
											<X aria-hidden="true" />
										</Button>
									</div>
								);
							})}
						</Card>
					)}
					<p className="m-0 text-xs text-silt">Jobs go to the first backend that has the model.</p>
				</section>

				<section className="grid grid-cols-2 gap-3">
					<Option title="Concurrent jobs" caption="Advertised to the server">
						<div className="flex items-center overflow-hidden rounded-sm border border-line-strong">
							<button type="button" aria-label="Fewer" onClick={() => setConcurrency((n) => Math.max(1, n - 1))} className="flex h-[30px] w-8 items-center justify-center bg-reef">
								<Minus size={14} aria-hidden="true" />
							</button>
							<span className="w-9 text-center font-mono text-sm">{concurrency}</span>
							<button type="button" aria-label="More" onClick={() => setConcurrency((n) => n + 1)} className="flex h-[30px] w-8 items-center justify-center bg-reef">
								<Plus size={14} aria-hidden="true" />
							</button>
						</div>
					</Option>
					<Option title="Launch at login" caption="Starts in the menu bar">
						<button
							type="button"
							role="switch"
							aria-checked={launchAtLogin}
							aria-label="Launch at login"
							onClick={() => setLaunchAtLogin((on) => !on)}
							className="flex h-[22px] w-[38px] rounded-full bg-line-strong p-0.5 aria-checked:justify-end aria-checked:bg-lumen"
						>
							<span className="size-[18px] rounded-full bg-abyss" />
						</button>
					</Option>
				</section>

				{errors.length > 0 && (
					<ul role="alert" className="m-0 flex list-none flex-col gap-1 p-0 text-sm text-coral">
						{errors.map((error) => (
							<li key={error}>{error}</li>
						))}
					</ul>
				)}
			</Body>
			<div className="flex items-center justify-end gap-3 border-t border-line bg-trench px-[30px] py-3.5">
				<span className="mr-auto text-xs text-mist">Changing the server or token reconnects; running jobs are abandoned.</span>
				<Button type="button" variant="outline" size="sm" onClick={onReload}>
					Revert
				</Button>
				<Button type="submit" size="sm" disabled={saving}>
					{saving ? "Saving…" : "Save and reconnect"}
				</Button>
			</div>
		</form>
	);
}

function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
	const id = useId();
	return (
		<>
			<label htmlFor={id} className="text-[13px] text-mist">
				{label}
			</label>
			{children(id)}
		</>
	);
}

function Option({ title, caption, children }: { title: string; caption: string; children: ReactNode }) {
	return (
		<div className="flex items-center justify-between gap-3 rounded-[10px] border border-line bg-shelf px-4 py-3.5">
			<div className="flex flex-col gap-[3px]">
				<span className="text-[13px]">{title}</span>
				<span className="text-xs text-silt">{caption}</span>
			</div>
			{children}
		</div>
	);
}
