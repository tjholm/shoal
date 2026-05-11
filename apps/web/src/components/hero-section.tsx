import { ClientOnly } from "@tanstack/react-router"
import { ShoalCanvas } from "./shoal-canvas"

export function HeroSection() {
	return (
		<section className="relative isolate overflow-hidden border-b border-[var(--line)]">
			<div className="relative flex min-h-[640px] h-[min(880px,90vh)] items-center justify-center">
				<ClientOnly fallback={null}>
					<ShoalCanvas />
				</ClientOnly>
				<div
					className="page-wrap relative flex justify-center"
					style={{ zIndex: 10 }}
				>
					<BannerCard />
				</div>
			</div>
		</section>
	)
}

function BannerCard() {
	return (
		<div
			className="mx-4 max-w-[640px] bg-[var(--bg-base)] px-8 py-12 text-center sm:px-12 sm:py-14"
			style={{
				maskImage:
					"radial-gradient(ellipse 75% 80% at center, black 30%, transparent 100%)",
				WebkitMaskImage:
					"radial-gradient(ellipse 75% 80% at center, black 30%, transparent 100%)",
			}}
		>
			<span className="island-kicker">Your private AI Cloud</span>
			<h1 className="display-title mt-4 text-5xl leading-[1.04] text-[var(--sea-ink)] sm:text-6xl">
				Shoal
			</h1>
			<p className="mx-auto mt-5 max-w-[520px] text-lg leading-relaxed text-[var(--sea-ink-soft)]">
				Local-first AI that swims with you. Bring your own models, route
				work between agents, and keep every byte in waters you control.
			</p>
			<div className="mt-8 flex flex-wrap justify-center gap-3">
				<a
					href="#philosophy"
					className="inline-flex items-center rounded-sm border border-[var(--lagoon-line)] bg-[var(--lagoon-soft)] px-5 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] transition hover:bg-[var(--lagoon-line)] hover:text-[var(--lagoon)]"
				>
					See how it works
				</a>
			</div>
		</div>
	)
}
