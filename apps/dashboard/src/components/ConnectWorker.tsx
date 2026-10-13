import { Fragment, useState } from "react";
import { CopyButton } from "./CopyButton";
import { Segmented } from "@shoal/ui/components/Segmented";
import { CreateKeyStep, Step, Steps } from "./Steps";

export interface BackendPreset {
	key: string;
	label: string;
	/** A short monogram for the preset's tile. */
	mono: string;
	/** The backend's usual local URL. */
	url: string;
	hint: string;
}

/** Backends the worker knows how to read, at their usual ports. Ollama is
 *  the worker's default, so its command needs no `--backend` flag. */
export const BACKEND_PRESETS: ReadonlyArray<BackendPreset> = [
	{ key: "ollama", label: "Ollama", mono: "OL", url: "http://localhost:11434", hint: "default · :11434" },
	{ key: "lmstudio", label: "LM Studio", mono: "LM", url: "http://localhost:1234", hint: ":1234" },
	{ key: "llamacpp", label: "llama.cpp", mono: "cpp", url: "http://localhost:8080", hint: "llama-server · :8080" },
	{ key: "llamaswap", label: "llama-swap", mono: "sw", url: "http://localhost:8080", hint: ":8080" },
	{ key: "vllm", label: "vLLM", mono: "vL", url: "http://localhost:8000", hint: ":8000" },
	{ key: "lemonade", label: "Lemonade", mono: "Le", url: "http://localhost:8000", hint: ":8000" },
	{ key: "custom", label: "Custom", mono: "···", url: "", hint: "any URL" },
];

const DEFAULT_BACKEND = "ollama";

/** Where the worker will run, which decides how its command is written. */
export type WorkerOs = "macos" | "linux" | "windows";

const OS_OPTIONS: ReadonlyArray<{ value: WorkerOs; label: string }> = [
	{ value: "macos", label: "macOS" },
	{ value: "linux", label: "Linux" },
	{ value: "windows", label: "Windows" },
];

/** The browser's OS, as the likeliest guess for the worker machine. */
function detectOs(): WorkerOs {
	const { userAgentData } = navigator as { userAgentData?: { platform: string } };
	const platform = userAgentData?.platform ?? navigator.userAgent;
	if (/mac|iphone|ipad/i.test(platform)) return "macos";
	if (/win/i.test(platform)) return "windows";
	return "linux";
}

export function BackendPicker({
	value,
	onChange,
	compact = false,
}: {
	value: string;
	onChange: (key: string) => void;
	compact?: boolean;
}) {
	return (
		<div
			role="radiogroup"
			aria-label="Backend"
			className={`grid gap-2 ${compact ? "grid-cols-[repeat(auto-fill,minmax(150px,1fr))]" : "grid-cols-[repeat(auto-fill,minmax(170px,1fr))]"}`}
		>
			{BACKEND_PRESETS.map((preset) => {
				const selected = preset.key === value;
				return (
					<button
						key={preset.key}
						type="button"
						role="radio"
						aria-checked={selected}
						onClick={() => onChange(preset.key)}
						className={`flex min-w-0 items-center gap-3 rounded-sm border text-left text-foam ${compact ? "p-2.5" : "p-3"} ${
							selected
								? "border-lumen bg-lumen/8"
								: "border-line bg-trench hover:border-line-strong"
						}`}
					>
						<span
							aria-hidden="true"
							className={`flex shrink-0 items-center justify-center rounded-sm border border-line-strong bg-reef font-mono text-mist ${compact ? "size-7 text-[10.5px]" : "size-9 text-xs"}`}
						>
							{preset.mono}
						</span>
						<span className="flex min-w-0 flex-col gap-0.5">
							<span className={`font-medium ${compact ? "text-[13px]" : "text-sm"}`}>
								{preset.label}
							</span>
							<span className="truncate font-mono text-[11px] text-silt">{preset.hint}</span>
						</span>
					</button>
				);
			})}
		</div>
	);
}

/** The worker command for a backend, written for `os`'s shell. The copy
 *  button copies exactly what is shown. Without a token the command carries
 *  a placeholder. */
export function WorkerCommand({
	serverWsUrl,
	token,
	backend,
	customUrl,
	os,
	header,
}: {
	serverWsUrl: string;
	token: string | undefined;
	backend: string;
	customUrl: string;
	os: WorkerOs;
	/** Rendered in the box's top bar, beside the copy button. */
	header?: React.ReactNode;
}) {
	const preset = BACKEND_PRESETS.find((p) => p.key === backend);
	const backendUrl = backend === "custom" ? customUrl || "http://<host>:<port>" : preset?.url;
	const needsFlag = backend !== DEFAULT_BACKEND && backendUrl !== undefined;
	const program = "npx @shoal.school/cli worker start";
	const tokenText = token ?? "<your API key>";
	const args = [
		{ flag: "--server", value: serverWsUrl },
		{ flag: "--token", value: tokenText, placeholder: !token },
		...(needsFlag ? [{ flag: "--backend", value: backendUrl }] : []),
	];
	// Windows cmd and PowerShell don't understand `\` continuations, so there
	// the command is one line, wrapped only on screen.
	const multiline = os !== "windows";
	const plain = [program, ...args.map((arg) => `${arg.flag} ${arg.value}`)].join(
		multiline ? " \\\n    " : " ",
	);

	return (
		<div className="flex flex-col rounded-sm border border-line bg-trench">
			{header && (
				<div className="flex items-center justify-between gap-2.5 border-b border-line py-1.5 pr-1.5 pl-3.5">
					{header}
					<CopyButton
						value={plain}
						label="Copy command"
						className="size-[30px] border border-line-strong bg-reef text-foam"
					/>
				</div>
			)}
			<div className="flex items-start">
				<pre
					className={`m-0 min-w-0 grow px-4 py-3.5 font-mono text-[12.5px] leading-[1.75] text-foam ${multiline ? "overflow-x-auto" : "break-all whitespace-pre-wrap"}`}
				>
					{/* Unselectable, so selecting the command by hand copies it runnable. */}
					<span className="select-none text-silt">{multiline ? "$ " : "> "}</span>
					{program}
					{args.map((arg) => (
						<Fragment key={arg.flag}>
							{multiline ? (
								<>
									<span className="text-silt"> \</span>
									{"\n    "}
								</>
							) : (
								" "
							)}
							<span className="text-mist">{arg.flag}</span>{" "}
							<span className={arg.placeholder ? "text-amber" : "text-[var(--signal-current)]"}>
								{arg.value}
							</span>
						</Fragment>
					))}
				</pre>
				{!header && (
					<CopyButton
						value={plain}
						label="Copy command"
						className="m-2 size-8 border border-line-strong bg-reef text-foam"
					/>
				)}
			</div>
		</div>
	);
}

/** Connect a worker in two steps: create a token (filled into the
 *  command), then pick the OS and backend and copy the command. */
export function ConnectSteps({ serverWsUrl }: { serverWsUrl: string }) {
	const [os, setOs] = useState(detectOs);
	const [backend, setBackend] = useState("ollama");
	const [customUrl, setCustomUrl] = useState("");
	const [token, setToken] = useState<string | undefined>();

	return (
		<Steps>
			<CreateKeyStep
				title="Create a worker token"
				defaultName="worker"
				description="An API key scoped to this organization. Name it after the machine."
				created={token}
				onCreated={setToken}
			/>
			<Step n={2} done={false} last>
				<div className="flex flex-col gap-1">
					<span className="text-[15px] font-semibold text-foam">
						Run a worker next to your backend
					</span>
					<span className="text-[13px] text-mist">
						Pick what's serving models on that machine. Ports are the usual defaults; edit the
						command if yours differ.
					</span>
				</div>
				<BackendPicker value={backend} onChange={setBackend} compact />
				{backend === "custom" && (
					<div className="flex max-w-[420px] flex-col gap-1.5">
						<label htmlFor="backend-url" className="text-xs text-mist">
							Backend URL, as the worker machine sees it
						</label>
						<input
							id="backend-url"
							type="url"
							value={customUrl}
							onChange={(e) => setCustomUrl(e.target.value)}
							placeholder="http://localhost:9000"
							className="h-9 rounded-sm border border-input bg-trench px-2.5 font-mono text-[12.5px] text-foam placeholder:text-silt"
						/>
					</div>
				)}
				<div className="flex flex-col gap-2">
					<div className="self-start">
						<Segmented
							label="Worker operating system"
							size="sm"
							value={os}
							options={OS_OPTIONS}
							onChange={setOs}
						/>
					</div>
					{/* Each OS's ways to run a worker. npx is the only one for now. */}
					<div
						role="tabpanel"
						aria-label={OS_OPTIONS.find((o) => o.value === os)?.label}
						className="flex flex-col gap-2.5 rounded-sm border border-line p-3.5"
					>
						<span className="text-[13px] text-mist">
							Run it with npx. Needs Node 22 or later on the worker machine.
						</span>
						<WorkerCommand
							serverWsUrl={serverWsUrl}
							token={token}
							backend={backend}
							customUrl={customUrl}
							os={os}
						/>
					</div>
				</div>
			</Step>
		</Steps>
	);
}
