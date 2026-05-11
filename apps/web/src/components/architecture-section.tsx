import type { ReactNode } from "react"
import {
	SiAnthropic,
	SiCrewai,
	SiHaystack,
	SiLangchain,
	SiOpenai,
	SiZedindustries,
} from "react-icons/si"

interface Tool {
	name: string
	icon: ReactNode
	iconOnly?: boolean
}

const ICON_SIZE = 14

const TOOLS: ReadonlyArray<Tool> = [
	{ name: "opencode", icon: <OpencodeMark height={12} />, iconOnly: true },
	{ name: "OpenAI SDK", icon: <SiOpenai size={ICON_SIZE} /> },
	{ name: "Anthropic SDK", icon: <SiAnthropic size={ICON_SIZE} /> },
	{ name: "LangChain", icon: <SiLangchain size={ICON_SIZE} /> },
	{ name: "CrewAI", icon: <SiCrewai size={ICON_SIZE} /> },
	{ name: "Haystack", icon: <SiHaystack size={ICON_SIZE} /> },
	{ name: "Zed", icon: <SiZedindustries size={ICON_SIZE} /> },
]

function OpencodeMark({ height = 12 }: { height?: number }) {
	const ratio = 234 / 42
	return (
		<svg
			role="img"
			aria-label="opencode"
			width={height * ratio}
			height={height}
			viewBox="0 0 234 42"
			fill="currentColor"
			fillRule="evenodd"
			xmlns="http://www.w3.org/2000/svg"
		>
			<path d="M18 12H6V30H18V12ZM24 36H0V6H24V36Z" />
			<path d="M36 30H48V12H36V30ZM54 36H36V42H30V6H54V36Z" />
			<path d="M84 24H66V30H84V36H60V6H84V24ZM66 18H78V12H66V18Z" />
			<path d="M108 12H96V36H90V6H108V12ZM114 36H108V12H114V36Z" />
			<path d="M144 12H126V30H144V36H120V6H144V12Z" />
			<path d="M168 12H156V30H168V12ZM174 36H150V6H174V36Z" />
			<path d="M198 12H186V30H198V12ZM204 36H180V6H198V0H204V36Z" />
			<path d="M216 12V18H228V12H216ZM234 24H216V30H234V36H210V6H234V24Z" />
		</svg>
	)
}

interface Worker {
	hardware: string
	backend: string
	model: string
}

const WORKERS: ReadonlyArray<Worker> = [
	{ hardware: "Mac Studio M2 Ultra", backend: "Ollama", model: "llama-3.3-70b" },
	{ hardware: "RTX 4090", backend: "vLLM", model: "qwen2.5-coder-32b" },
	{ hardware: "Mac Mini M4", backend: "Ollama", model: "phi-4-14b" },
	{ hardware: "Raspberry Pi 5", backend: "llama.cpp", model: "smollm2-1.7b" },
]

export function ArchitectureSection() {
	return (
		<section
			id="architecture"
			className="relative overflow-hidden border-b border-[var(--line)] py-24 sm:py-32"
		>
			<div className="page-wrap">
				<div className="max-w-2xl">
					<span className="island-kicker">Architecture</span>
					<h2 className="display-title mt-3 text-4xl leading-[1.05] text-[var(--sea-ink)] sm:text-5xl">
						How the current flows.
					</h2>
					<p className="mt-5 text-lg leading-relaxed text-[var(--sea-ink-soft)]">
						Three tiers, one protocol, your hardware. Add or pull a
						worker — the rest of the system never notices.
					</p>
				</div>

				<div className="mx-auto mt-16 max-w-3xl">
					<Tier label="Your tools">
						<div className="mb-4 flex justify-center">
							<span className="inline-flex items-center gap-2 rounded-full border border-[var(--lagoon-line)] bg-[var(--lagoon-soft)] px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--lagoon-deep)]">
								<span className="inline-flex items-center gap-1">
									<SiOpenai size={11} />
									<SiAnthropic size={11} />
								</span>
								OpenAI &amp; Anthropic compatible
							</span>
						</div>
						<div className="flex flex-wrap justify-center gap-2">
							{TOOLS.map((tool) => (
								<ToolChip key={tool.name} {...tool} />
							))}
						</div>
					</Tier>

					<Connector />

					<Tier label="Shoal server">
						<div className="mx-auto max-w-xl">
							<article className="island-shell rounded-sm px-6 py-5 text-center">
								<div className="display-title text-2xl text-[var(--sea-ink)]">
									Auth · Dispatch · Queue · Audit
								</div>
								<div className="mt-2 text-sm leading-relaxed text-[var(--sea-ink-soft)]">
									Secures and observes your private AI cloud.
								</div>
							</article>
						</div>
					</Tier>

					<Connector />

					<Tier label="Worker fleet">
						<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
							{WORKERS.map((worker) => (
								<WorkerCard key={worker.hardware} {...worker} />
							))}
						</div>
					</Tier>
				</div>
			</div>
		</section>
	)
}

function Tier({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div>
			<div className="island-kicker text-center">{label}</div>
			<div className="mt-4">{children}</div>
		</div>
	)
}

function Connector() {
	return (
		<div className="my-6 flex justify-center" aria-hidden>
			<div
				className="h-14 w-px"
				style={{
					background:
						"linear-gradient(180deg, transparent, var(--lagoon-line) 30%, var(--lagoon-line) 70%, transparent)",
				}}
			/>
		</div>
	)
}

function ToolChip({ name, icon, iconOnly }: Tool) {
	return (
		<span className="inline-flex items-center gap-2 rounded-sm border border-[var(--line)] bg-[var(--surface-strong)] px-3.5 py-2 text-sm font-medium text-[var(--sea-ink)]">
			<span
				aria-hidden={iconOnly ? undefined : true}
				className="inline-flex text-[var(--lagoon-deep)]"
			>
				{icon}
			</span>
			{!iconOnly && <span>{name}</span>}
		</span>
	)
}

function WorkerCard({ hardware, backend, model }: Worker) {
	return (
		<article className="island-shell rounded-sm px-4 py-3 text-left">
			<div className="flex items-center gap-2">
				<span className="block h-2 w-2 rounded-full bg-[var(--lagoon-deep)]" />
				<span className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--lagoon-deep)]">
					{backend}
				</span>
			</div>
			<div className="mt-1.5 text-sm font-semibold text-[var(--sea-ink)]">
				{hardware}
			</div>
			<div className="mt-0.5 text-xs text-[var(--sea-ink-soft)]">
				↳ {model}
			</div>
		</article>
	)
}
