import { SectionHeading } from "./brand"

interface MockWorker {
	name: string
	hardware: string
	working: boolean
	busy: number
	slots: number
	tokens: string
	models: ReadonlyArray<{ name: string; hot: boolean }>
}

// Illustrative machines, not anyone's real fleet.
const WORKERS: ReadonlyArray<MockWorker> = [
	{
		name: "framework-desktop",
		hardware: "Strix Halo · 128 GB · Lemonade",
		working: true,
		busy: 3,
		slots: 4,
		tokens: "2.41M tok",
		models: [
			{ name: "qwen3-32b", hot: true },
			{ name: "gemma-3-27b", hot: true },
			{ name: "flux-schnell", hot: true },
			{ name: "kokoro-tts", hot: false },
		],
	},
	{
		name: "fw13-laptop",
		hardware: "HX 370 · Ollama",
		working: true,
		busy: 1,
		slots: 2,
		tokens: "318K tok",
		models: [
			{ name: "qwen3-coder-30b", hot: true },
			{ name: "phi-4-mini", hot: false },
		],
	},
	{
		name: "mac-mini",
		hardware: "M4 Pro · 64 GB · LM Studio",
		working: false,
		busy: 0,
		slots: 4,
		tokens: "606 tok",
		models: [
			{ name: "gemma-3-12b", hot: true },
			{ name: "smollm3-3b", hot: false },
		],
	},
]

export function DashboardSection() {
	return (
		<section aria-label="Dashboard" className="page-wrap flex flex-wrap items-center gap-12 py-24">
			<div className="flex-[1_1_320px]">
				<SectionHeading size="md" title="Your whole fleet at a glance">
					The dashboard shows what's connected, what's loaded and what's busy, and warns you when a
					kind of model only lives on one machine.
				</SectionHeading>
			</div>
			<div
				aria-hidden="true"
				className="flex min-w-0 flex-[999_1_560px] flex-col gap-2.5 rounded-lg border border-line bg-trench p-4"
			>
				{WORKERS.map((w, i) => (
					<div
						key={w.name}
						className={`flex flex-col gap-3 rounded-md border bg-shelf px-4 py-3.5 ${i === 0 ? "border-lumen-edge" : "border-line"}`}
					>
						<div className="flex flex-wrap items-center gap-x-6 gap-y-3">
							<span className="flex min-w-0 flex-[1_1_200px] flex-col gap-1">
								<span className="flex items-center gap-2">
									<span className="font-mono text-sm font-medium text-foam">{w.name}</span>
									<span
										className={`inline-flex h-5 items-center rounded-[2px] border px-1.5 font-mono text-[11px] ${w.working ? "border-lumen-edge bg-lumen-wash text-lumen" : "border-line-strong bg-reef text-mist"}`}
									>
										● {w.working ? "working" : "idle"}
									</span>
								</span>
								<span className="text-xs text-silt">{w.hardware}</span>
							</span>
							<span className="flex w-[88px] gap-[3px]">
								{Array.from({ length: w.slots }, (_, s) => (
									<span
										// biome-ignore lint/suspicious/noArrayIndexKey: slots have no identity
										key={s}
										className={`h-3 flex-1 rounded-[2px] border ${s < w.busy ? "border-lumen bg-lumen" : "border-line-strong"}`}
									/>
								))}
							</span>
							<span className="w-[92px] text-right font-mono text-xs text-mist">{w.tokens}</span>
						</div>
						<div className="flex flex-wrap gap-1.5">
							{w.models.map((m) => (
								<span
									key={m.name}
									className={`inline-flex h-[22px] items-center gap-1.5 rounded-[2px] border px-[7px] font-mono text-[11px] ${m.hot ? "border-lumen-edge text-foam" : "border-line text-mist"}`}
								>
									{m.name}
									{m.hot && <span className="text-lumen">hot</span>}
								</span>
							))}
						</div>
					</div>
				))}
			</div>
		</section>
	)
}
