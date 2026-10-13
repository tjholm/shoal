import { Button } from "@shoal/ui/components/button";
import { Input } from "@shoal/ui/components/input";
import { Section } from "@shoal/ui/components/Page";
import { Plus, X } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import type { SettingsView as SavedSettings } from "../shared/rpc";
import { rpc } from "./rpc";

// Ollama's default address is the most likely first model server.
const DEFAULT_BACKEND = "http://localhost:11434";

let nextRowId = 0;
const row = (value: string) => ({ id: nextRowId++, value });

export function SettingsView({ onSaved }: { onSaved: () => void }) {
	const [saved, setSaved] = useState<SavedSettings | null | undefined>(undefined);

	useEffect(() => {
		void rpc.request.getSettings().then(setSaved);
	}, []);

	// Wait for the saved settings so the form starts from them, not blanks.
	if (saved === undefined) return null;
	return <SettingsForm saved={saved} onSaved={onSaved} />;
}

function SettingsForm({ saved, onSaved }: { saved: SavedSettings | null; onSaved: () => void }) {
	const [serverUrl, setServerUrl] = useState(saved?.serverUrl ?? "");
	const [token, setToken] = useState("");
	const [backends, setBackends] = useState(() => (saved?.backends ?? [DEFAULT_BACKEND]).map(row));
	const [errors, setErrors] = useState<ReadonlyArray<string>>([]);
	const [saving, setSaving] = useState(false);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setSaving(true);
		const result = await rpc.request.saveSettings({
			serverUrl,
			token,
			backends: backends.map((b) => b.value),
		});
		setSaving(false);
		if (result.ok) onSaved();
		else setErrors(result.errors);
	};

	return (
		<form onSubmit={submit} noValidate className="flex flex-col gap-6 px-5 pt-7 pb-10">
			<div className="rise-in flex flex-col gap-2.5">
				<h1 className="font-mono text-[32px] leading-none font-medium tracking-[-0.03em] text-foam">
					settings
				</h1>
				<p className="text-sm text-mist">
					Connect this computer to your shoal server and tell it where your models run.
				</p>
			</div>

			<Section title="Server" caption="Find both in your shoal dashboard under Connect worker.">
				<div className="flex flex-col gap-4 px-[18px] py-4">
					<Field label="Server address" hint="The address you open your shoal dashboard at.">
						{(id) => (
							<Input
								id={id}
								value={serverUrl}
								onChange={(e) => setServerUrl(e.target.value)}
								placeholder="https://shoal.example.com"
								autoComplete="off"
							/>
						)}
					</Field>
					<Field
						label="API key"
						hint={saved?.hasToken ? "Saved. Leave blank to keep it." : "Create one under API keys."}
					>
						{(id) => (
							<Input
								id={id}
								type="password"
								value={token}
								onChange={(e) => setToken(e.target.value)}
								placeholder={saved?.hasToken ? "••••••••" : "sk_…"}
								autoComplete="off"
							/>
						)}
					</Field>
				</div>
			</Section>

			<Section
				title="Model servers"
				caption="Where your models run, like Ollama or LM Studio."
				actions={
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => setBackends((rows) => [...rows, row("")])}
					>
						<Plus aria-hidden="true" />
						Add
					</Button>
				}
			>
				<ul>
					{backends.map((backend, index) => (
						<li
							key={backend.id}
							className="flex items-center gap-2 border-b border-line px-[18px] py-3 last:border-b-0"
						>
							<Input
								aria-label={`Model server ${index + 1}`}
								value={backend.value}
								onChange={(e) =>
									setBackends((rows) =>
										rows.map((r) => (r.id === backend.id ? { ...r, value: e.target.value } : r)),
									)
								}
								placeholder={DEFAULT_BACKEND}
								className="font-mono"
								autoComplete="off"
							/>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								aria-label={`Remove model server ${index + 1}`}
								onClick={() => setBackends((rows) => rows.filter((r) => r.id !== backend.id))}
							>
								<X aria-hidden="true" />
							</Button>
						</li>
					))}
				</ul>
			</Section>

			{errors.length > 0 && (
				<ul role="alert" className="flex flex-col gap-1 text-sm text-coral">
					{errors.map((error) => (
						<li key={error}>{error}</li>
					))}
				</ul>
			)}

			<div className="flex gap-2">
				<Button type="submit" disabled={saving}>
					Save
				</Button>
			</div>
		</form>
	);
}

function Field({
	label,
	hint,
	children,
}: {
	label: string;
	hint: string;
	children: (id: string) => React.ReactNode;
}) {
	const id = useId();
	return (
		<div className="flex flex-col gap-1.5">
			<label htmlFor={id} className="text-sm font-semibold text-mist">
				{label}
			</label>
			{children(id)}
			<span className="text-xs text-silt">{hint}</span>
		</div>
	);
}
