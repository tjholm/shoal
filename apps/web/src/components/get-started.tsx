import {
	Command,
	GITHUB_URL,
	GitHubIcon,
	INSTALL_COMMAND,
	SecondaryLink,
	SectionHeading,
} from "./brand"

export function GetStarted() {
	const flag = (text: string) => <span className="text-mist">{text}</span>
	const value = (text: string) => <span className="text-[var(--signal-current)]">{text}</span>
	const cont = <span className="text-silt"> \</span>

	return (
		<section id="start" className="scroll-mt-16 border-t border-line bg-trench">
			<div className="page-wrap flex flex-col gap-10 py-24">
				<SectionHeading title="Get started" />
				<div className="grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] gap-5">
					<Step n={1} title="Run the server">
						<Command>{INSTALL_COMMAND}</Command>
						<p>
							Needs Docker. Run it anywhere your apps and workers can both reach: it's the only
							piece that needs an address. On Windows:{" "}
							<code className="font-mono text-foam">irm https://shoal.school/install.ps1 | iex</code>
						</p>
					</Step>
					<Step n={2} title="Add workers">
						<Command>
							npx @shoal.school/cli worker start{cont}
							{"\n    "}
							{flag("--server")} {value("wss://shoal.example.com/ws/workers")}
							{cont}
							{"\n    "}
							{flag("--token")} {value("sk_…")}
						</Command>
						<p>
							On each machine with a model server. <span className="text-foam">Connect worker</span>{" "}
							in the dashboard fills in the server and token for you.
						</p>
					</Step>
				</div>
				<div className="flex flex-wrap gap-3">
					<SecondaryLink href={GITHUB_URL} size="lg">
						<GitHubIcon />
						Star on GitHub
					</SecondaryLink>
				</div>
			</div>
		</section>
	)
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
	return (
		<div className="flex min-w-0 flex-col gap-3 text-[13px] leading-relaxed text-mist">
			<span className="flex items-baseline gap-2.5">
				<span className="font-mono text-[13px] text-lumen">0{n}</span>
				<span className="text-base font-semibold text-foam">{title}</span>
			</span>
			{children}
		</div>
	)
}
