import { CopyCommand, GITHUB_URL, INSTALL_COMMAND, PrimaryLink, SecondaryLink } from "./brand"
import { ShoalCanvas } from "./shoal-canvas"

export function HeroSection() {
	return (
		// Clips the animation's overhang to the hero, so it can't widen the page.
		<div className="overflow-clip">
			<section className="mx-auto flex max-w-[1280px] flex-wrap items-center gap-x-12 gap-y-8 px-6 py-16 sm:py-[72px]">
				<div className="relative z-10 flex min-w-0 flex-[999_1_480px] flex-col gap-7">
					<span className="font-mono text-[12.5px] tracking-[0.08em] text-lumen uppercase">
						Distributed local inference
					</span>
					<h1 className="font-mono text-[44px] leading-[1.04] font-medium tracking-[-0.045em] text-foam sm:text-[64px]">
						Every machine you own.
						<br />
						<span className="text-mist">One endpoint.</span>
					</h1>
					<p className="max-w-[560px] text-lg leading-relaxed text-mist sm:text-[19px]">
						shoal puts the GPUs and Macs you already have behind a single OpenAI- and
						Anthropic-compatible endpoint. Workers run beside your model servers and dial out to it,
						so nothing needs a port opened.
					</p>
					<div className="flex flex-wrap items-center gap-3">
						<PrimaryLink href="#start" size="lg">
							Self-host shoal
						</PrimaryLink>
						<SecondaryLink href={GITHUB_URL} size="lg">
							View on GitHub
						</SecondaryLink>
					</div>
					<div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
						<CopyCommand command={INSTALL_COMMAND} />
						<span className="font-mono text-xs text-silt">Apache-2.0</span>
					</div>
				</div>
				<div className="hidden min-w-0 max-w-[620px] flex-[1_1_420px] lg:flex">
					<ShoalCanvas />
				</div>
			</section>
		</div>
	)
}
