import { SectionHeading } from "./brand"

export function DropIn() {
	return (
		<section aria-label="Drop-in" className="border-y border-line bg-trench">
			<div className="page-wrap flex flex-wrap items-center gap-12 py-16">
				<div className="flex-[1_1_320px]">
					<SectionHeading
						size="md"
						title={
							<>
								Change one line.
								<br />
								Keep your code.
							</>
						}
					>
						Anything that speaks the OpenAI or Anthropic API already speaks shoal: SDKs, chat apps,
						coding agents, your own scripts. Point the base URL at your server and use a model any
						worker has.
					</SectionHeading>
				</div>
				<div className="min-w-0 flex-[999_1_520px] overflow-hidden rounded-md border border-line bg-abyss">
					<div className="flex h-10 items-center border-b border-line bg-shelf px-4 font-mono text-xs text-mist">
						app.py
					</div>
					<pre className="m-0 overflow-x-auto py-4 font-mono text-[13.5px] leading-[1.8] text-mist">
						<span className="block px-[18px]">client = OpenAI(</span>
						<span className="block bg-coral-wash/70 px-[18px] text-coral">
							{'-    base_url="https://api.openai.com/v1",'}
						</span>
						<span className="block bg-lumen-wash/70 px-[18px] text-lumen">
							{'+    base_url="https://shoal.example.com/api/v1",'}
						</span>
						<span className="block px-[18px]">{'     api_key=os.environ["SHOAL_API_KEY"],'}</span>
						<span className="block px-[18px]">)</span>
						<span className="block px-[18px]">
							client.chat.completions.create(model="
							<span className="text-foam">qwen3-32b</span>", ...)
						</span>
					</pre>
				</div>
			</div>
		</section>
	)
}

const FEATURES = [
	{
		title: "Outbound only",
		body: "Workers open a WebSocket to the server. Laptops behind NAT, boxes on another network, a GPU at a friend’s place: if it can reach the server, it can join.",
	},
	{
		title: "Routes to what’s warm",
		body: "Requests go to a worker that already has the model loaded and a free slot, so you aren’t paying a cold load for every call.",
	},
	{
		title: "Bring any backend",
		body: "Presets for Ollama, LM Studio, llama.cpp, llama-swap, vLLM and Lemonade. Anything else, point --backend at it.",
	},
	{
		title: "More than chat",
		body: "Chat, vision, embeddings, image generation and text-to-speech sit behind the same API, on whichever machine has the hardware for them.",
	},
	{
		title: "Slots, not guesswork",
		body: "Each worker declares how many jobs it can run at once. The server respects it, so a laptop never gets the load meant for a workstation.",
	},
	{
		title: "Share with your team",
		body: "Organizations, members and API keys. Everyone adds machines to one pool and calls it with their own key.",
	},
]

const BACKENDS = [
	{ name: "Ollama", mono: "OL" },
	{ name: "LM Studio", mono: "LM" },
	{ name: "llama.cpp", mono: "cpp" },
	{ name: "llama-swap", mono: "sw" },
	{ name: "vLLM", mono: "vL" },
	{ name: "Lemonade", mono: "Le" },
]

export function HowItWorks() {
	return (
		<>
			<section id="how" className="page-wrap flex scroll-mt-16 flex-col gap-10 pt-24 pb-8">
				<SectionHeading title="How it works" />
				<div className="flex flex-wrap items-stretch gap-3 md:gap-0">
					<Box label="Your apps">
						<div className="flex flex-col gap-1.5 font-mono text-[13px] text-foam">
							{["openai & anthropic sdks", "chat apps, coding agents", "curl, scripts, cron"].map(
								(app) => (
									<span key={app} className="rounded-sm border border-line bg-trench px-2.5 py-2">
										{app}
									</span>
								),
							)}
						</div>
					</Box>
					<Wire label="https /api/v1" note="requests →" tone="var(--signal-current)" />
					<div className="flex min-w-0 flex-[1_1_240px] flex-col gap-3 rounded-md border border-lumen-edge bg-lumen-wash/40 p-5">
						<span className="font-mono text-[11px] tracking-[0.08em] text-lumen uppercase">
							shoal server
						</span>
						<div className="flex flex-col gap-2 text-[13.5px] leading-normal text-mist">
							<span>
								<span className="text-foam">Knows</span> which worker has which model loaded, and
								how many slots are free.
							</span>
							<span>
								<span className="text-foam">Routes</span> each request to a worker that can take it
								now.
							</span>
							<span>
								<span className="text-foam">Holds</span> your org, members and keys.
							</span>
						</div>
					</div>
					<Wire label="wss" note="← workers dial out" tone="var(--signal-lumen)" />
					<Box label="Workers">
						<div className="flex flex-col gap-1.5 font-mono text-[12.5px] text-foam">
							{[
								{ name: "desktop · ollama", slots: "3/4", busy: true },
								{ name: "laptop · lm studio", slots: "1/2", busy: true },
								{ name: "homelab · vllm", slots: "0/4", busy: false },
							].map((w) => (
								<span
									key={w.name}
									className="flex items-center justify-between gap-3 rounded-sm border border-line bg-trench px-2.5 py-2"
								>
									<span className="truncate">{w.name}</span>
									<span className={w.busy ? "text-lumen" : "text-mist"}>
										{w.busy ? "●" : "○"} {w.slots}
									</span>
								</span>
							))}
						</div>
					</Box>
				</div>
			</section>

			<section aria-label="Features" className="page-wrap pt-8 pb-24">
				<div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-px overflow-hidden rounded-md border border-line bg-line">
					{FEATURES.map((feature, i) => (
						<div key={feature.title} className="flex flex-col gap-2.5 bg-abyss p-7">
							<span className="font-mono text-xs text-lumen">0{i + 1}</span>
							<h3 className="text-lg font-semibold text-foam">{feature.title}</h3>
							<p className="text-[14.5px] leading-relaxed text-mist">{feature.body}</p>
						</div>
					))}
				</div>
			</section>

			<section aria-label="Backends" className="border-y border-line">
				<div className="page-wrap flex flex-wrap items-center gap-x-9 gap-y-5 py-10">
					<span className="font-mono text-xs tracking-[0.08em] text-silt uppercase">
						Works with what you run
					</span>
					{BACKENDS.map((backend) => (
						<span key={backend.name} className="flex items-center gap-2.5 text-[15px] text-mist">
							<span
								aria-hidden="true"
								className="flex size-7 items-center justify-center rounded-sm border border-line-strong bg-reef font-mono text-[10.5px]"
							>
								{backend.mono}
							</span>
							{backend.name}
						</span>
					))}
					<span className="text-sm text-silt">
						or any URL with <code className="font-mono text-mist">--backend</code>
					</span>
				</div>
			</section>
		</>
	)
}

function Box({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex min-w-0 flex-[1_1_220px] flex-col gap-3 rounded-md border border-line bg-shelf p-5">
			<span className="font-mono text-[11px] tracking-[0.08em] text-silt uppercase">{label}</span>
			{children}
		</div>
	)
}

/** The connection between two boxes; hidden once they stack. */
function Wire({ label, note, tone }: { label: string; note: string; tone: string }) {
	return (
		<div
			aria-hidden="true"
			className="hidden flex-[0_1_120px] flex-col items-center justify-center gap-1.5 px-2 font-mono text-[11px] md:flex"
		>
			<span style={{ color: tone }}>{label}</span>
			<span className="h-0 w-full border-t border-dashed" style={{ borderColor: tone }} />
			<span className="text-silt">{note}</span>
		</div>
	)
}
