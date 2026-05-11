import type { ReactNode } from "react"

interface Pillar {
	number: string
	kicker: string
	heading: string
	body: string
	visual: ReactNode
}

const PILLARS: ReadonlyArray<Pillar> = [
	{
		number: "01",
		kicker: "Hardware",
		heading: "The fleet you already own.",
		body: "Engineers' laptops, idle workstations, the old Mac Studios in the lab. Shoal puts them on shared duty without buying a single new accelerator.",
		visual: <ExistingHardwareVisual />,
	},
	{
		number: "02",
		kicker: "Local",
		heading: "Stays in your waters.",
		body: "Models run on your hardware. Inference, embeddings, prompts, conversation history — none of it leaves the boundary you set, ever.",
		visual: <BoundaryVisual />,
	},
	{
		number: "03",
		kicker: "Open",
		heading: "Speaks what they already speak.",
		body: "OpenAI- and Anthropic-compatible APIs on the front. Plain Ollama, vLLM, llama.cpp, MLX on the back. Glue between parts you already trust.",
		visual: <CompatVisual />,
	},
]

export function PhilosophySection() {
	return (
		<section
			id="philosophy"
			className="border-b border-[var(--line)] py-24 sm:py-32"
		>
			<div className="page-wrap">
				<div className="max-w-2xl">
					<span className="island-kicker">Philosophy</span>
					<h2 className="display-title mt-3 text-4xl leading-[1.05] text-[var(--sea-ink)] sm:text-5xl">
						Built on what you already have.
					</h2>
					<p className="mt-5 text-lg leading-relaxed text-[var(--sea-ink-soft)]">
						Three principles underneath. The rest of the system flows
						from those.
					</p>
				</div>

				<div className="mt-14 space-y-5">
					<PillarBigCard pillar={PILLARS[0]} visualSide="right" />
					<PillarBigCard pillar={PILLARS[1]} visualSide="left" />
					<PillarBigCard pillar={PILLARS[2]} visualSide="right" />
				</div>
			</div>
		</section>
	)
}

function PillarBigCard({
	pillar,
	visualSide,
}: {
	pillar: Pillar
	visualSide: "left" | "right"
}) {
	const header = <PillarHeader key="header" pillar={pillar} />
	const visual = <div key="visual">{pillar.visual}</div>
	return (
		<article className="island-shell relative grid grid-cols-1 items-center gap-10 rounded-sm p-7 md:grid-cols-2 md:p-10">
			<div
				aria-hidden
				className="absolute hidden bg-[var(--line)] md:block"
				style={{
					top: 40,
					bottom: 40,
					left: "calc(50% - 0.5px)",
					width: 1,
				}}
			/>
			{visualSide === "left" ? [visual, header] : [header, visual]}
		</article>
	)
}

function PillarHeader({ pillar }: { pillar: Pillar }) {
	return (
		<div>
			<div className="flex items-baseline gap-3">
				<span className="font-mono text-sm font-semibold text-[var(--lagoon-deep)]">
					{pillar.number}
				</span>
				<span className="island-kicker">{pillar.kicker}</span>
			</div>
			<h3 className="display-title mt-3 text-3xl leading-[1.1] text-[var(--sea-ink)] sm:text-[2rem]">
				{pillar.heading}
			</h3>
			<p className="mt-4 max-w-md text-[15px] leading-relaxed text-[var(--sea-ink-soft)]">
				{pillar.body}
			</p>
		</div>
	)
}

// ----------------------------------------------------------------------
// Visuals

function BoundaryVisual() {
	const rows = [
		{ label: "models", value: "local" },
		{ label: "prompts", value: "local" },
		{ label: "conversations", value: "local" },
		{ label: "embeddings", value: "local" },
		{ label: "audit log", value: "local" },
	]
	return (
		<InsetPanel kicker="Your boundary">
			<ul className="font-mono text-[13px]">
				{rows.map((row) => (
					<BoundaryRow key={row.label} label={row.label} value={row.value} />
				))}
				<BoundaryRow label="outbound traffic" value="0" highlight />
			</ul>
		</InsetPanel>
	)
}

function BoundaryRow({
	label,
	value,
	highlight,
}: {
	label: string
	value: string
	highlight?: boolean
}) {
	return (
		<li
			className="flex items-center justify-between border-b border-dashed border-[var(--line)] py-1.5"
		>
			<span className="text-[var(--sea-ink-soft)]">{label}</span>
			<span
				className={
					highlight
						? "font-bold text-[var(--lagoon-deep)]"
						: "font-medium text-[var(--sea-ink)]"
				}
			>
				{value}
			</span>
		</li>
	)
}

function ExistingHardwareVisual() {
	const inventory = [
		{ count: "40", item: "MacBook Pro M3" },
		{ count: "8", item: "RTX 4090 desktops" },
		{ count: "4", item: "Mac Studio M2 Ultra" },
		{ count: "12", item: "Linux QA box" },
	]
	return (
		<InsetPanel
			kicker="Already on your network"
			meta={
				<span className="font-mono text-[11px] text-[var(--sea-ink-soft)]">
					$0 spent
				</span>
			}
		>
			<ul className="font-mono text-[13px]">
				{inventory.map((row) => (
					<li
						key={row.item}
						className="flex items-center justify-between border-b border-dashed border-[var(--line)] py-1.5 last:border-b-0"
					>
						<span className="text-[var(--sea-ink-soft)]">{row.item}</span>
						<span className="font-medium text-[var(--sea-ink)]">
							×{row.count}
						</span>
					</li>
				))}
			</ul>
			<div className="mt-3 flex items-center justify-between border-t border-[var(--line)] pt-3 font-mono text-[13px]">
				<span className="text-[var(--sea-ink-soft)]">
					new accelerators
				</span>
				<span className="font-bold text-[var(--lagoon-deep)]">0</span>
			</div>
		</InsetPanel>
	)
}

function CompatVisual() {
	const items = [
		{ name: "OpenAI API", detail: "drop-in for clients" },
		{ name: "Anthropic API", detail: "drop-in for clients" },
		{ name: "Ollama", detail: "backend" },
		{ name: "vLLM", detail: "backend" },
		{ name: "llama.cpp", detail: "backend" },
		{ name: "MLX", detail: "backend" },
		{ name: "MCP", detail: "tools" },
	]
	return (
		<InsetPanel kicker="Speaks">
			<ul className="space-y-2.5">
				{items.map((item) => (
					<CompatRow key={item.name} {...item} />
				))}
			</ul>
		</InsetPanel>
	)
}

function CompatRow({ name, detail }: { name: string; detail: string }) {
	return (
		<li className="flex items-center justify-between text-sm">
			<span className="flex items-center gap-2.5">
				<span aria-hidden className="font-bold text-[var(--lagoon-deep)]">
					✓
				</span>
				<span className="font-medium text-[var(--sea-ink)]">{name}</span>
			</span>
			<span className="text-[13px] text-[var(--sea-ink-soft)]">
				{detail}
			</span>
		</li>
	)
}

function InsetPanel({
	kicker,
	meta,
	children,
}: {
	kicker: string
	meta?: ReactNode
	children: ReactNode
}) {
	return (
		<div className="h-full rounded-sm border border-[var(--line)] bg-[var(--surface-strong)] p-5">
			<div className="mb-3 flex items-baseline justify-between">
				<span className="island-kicker">{kicker}</span>
				{meta}
			</div>
			{children}
		</div>
	)
}
