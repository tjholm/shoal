import { GITHUB_URL, GitHubIcon, PrimaryLink, RELEASES_URL, SecondaryLink, Wordmark } from "./brand"

const LINKS = [
	{ href: "#how", label: "How it works" },
	{ href: RELEASES_URL, label: "Releases" },
]

export function SiteHeader() {
	return (
		<header className="sticky top-0 z-40 border-b border-line bg-abyss/90 backdrop-blur">
			<div className="page-wrap flex h-16 items-center gap-7">
				<a href="/" aria-label="shoal home">
					<Wordmark size={26} />
				</a>
				<nav aria-label="Site" className="hidden items-center gap-6 text-sm text-mist sm:flex">
					{LINKS.map((link) => (
						<a key={link.label} href={link.href} className="hover:text-foam">
							{link.label}
						</a>
					))}
				</nav>
				<div className="grow" />
				<SecondaryLink href={GITHUB_URL}>
					<GitHubIcon />
					GitHub
				</SecondaryLink>
				<PrimaryLink href="#start">Get started</PrimaryLink>
			</div>
		</header>
	)
}

export function SiteFooter() {
	return (
		<footer className="border-t border-line">
			<div className="page-wrap flex flex-wrap items-start gap-x-12 gap-y-6 pt-10 pb-14">
				<div className="flex min-w-[240px] flex-[999_1_280px] flex-col gap-2.5">
					<Wordmark size={20} />
					<span className="text-[13px] text-silt">Open source under Apache-2.0.</span>
				</div>
				<nav aria-label="Footer" className="flex flex-wrap gap-x-8 gap-y-3 text-sm text-mist">
					<a href={GITHUB_URL} className="hover:text-foam">
						GitHub
					</a>
					<a href={RELEASES_URL} className="hover:text-foam">
						Releases
					</a>
				</nav>
			</div>
		</footer>
	)
}
