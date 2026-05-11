export function CtaSection() {
	return (
		<section id="get-started" className="py-24 sm:py-32">
			<div className="page-wrap">
				<div className="island-shell grid grid-cols-1 items-center gap-10 rounded-sm px-8 py-12 sm:px-12 sm:py-14 md:grid-cols-2 md:gap-12">
					<div>
						<span className="island-kicker">Get started</span>
						<h2 className="display-title mt-3 text-4xl leading-[1.05] text-[var(--sea-ink)] sm:text-5xl">
							Start Shoaling.
						</h2>
						<p className="mt-5 max-w-md text-lg leading-relaxed text-[var(--sea-ink-soft)]">
							One container brings up the server and dashboard. Point
							a worker at it from anywhere on your fleet.
						</p>
						<div className="mt-8 flex flex-wrap gap-3">
							<a
								href="https://github.com/nitrictech/shoal"
								className="inline-flex items-center rounded-sm border border-[var(--lagoon-line)] bg-[var(--lagoon-soft)] px-5 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] transition hover:bg-[var(--lagoon-line)] hover:text-[var(--lagoon)]"
							>
								Star on GitHub
							</a>
						</div>
					</div>

					<pre className="min-w-0 overflow-x-auto rounded-sm border border-[var(--line)] bg-[var(--surface-strong)] p-5 text-sm leading-7 text-[var(--sea-ink)]">
						<code className="font-mono">
							<span className="text-[var(--sea-ink-muted)]">$</span>{" "}
							docker pull ghcr.io/nitrictech/shoal-lite
							{"\n"}
							<span className="text-[var(--sea-ink-muted)]">$</span>{" "}
							docker run -p 3000:3000 ghcr.io/nitrictech/shoal-lite
						</code>
					</pre>
				</div>
			</div>
		</section>
	)
}
