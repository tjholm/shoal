import { useState } from "react"

export const GITHUB_URL = "https://github.com/tjholm/shoal"
export const RELEASES_URL = `${GITHUB_URL}/releases`
export const INSTALL_COMMAND = "curl -fsSL https://shoal.school/install.sh | sh"

/** The shoal glyph: three fish around a Lumen hub, in the current colour. */
export function Glyph({ size = 22 }: { size?: number }) {
	const fish = "M8 4 C10 1.4 14 1.4 16 4 C14 6.6 10 6.6 8 4 Z M8 4 L5.5 2 L5.5 6 Z"
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<g stroke="currentColor" strokeWidth={1.5}>
				<path d={fish} />
				<path transform="rotate(120 12 12)" d={fish} />
				<path transform="rotate(240 12 12)" d={fish} />
			</g>
			<circle cx="12" cy="12" r="2.3" fill="var(--signal-lumen)" />
		</svg>
	)
}

export function Wordmark({ size = 24 }: { size?: number }) {
	return (
		<span className="flex items-center gap-2.5">
			<span className="flex text-mist">
				<Glyph size={size} />
			</span>
			<span className="font-mono text-lg font-medium tracking-[-0.03em] text-foam">shoal</span>
		</span>
	)
}

export function GitHubIcon() {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 20 20"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M7 15.5c-3 1-3-1.5-4.5-2M12.5 17.5v-2.8a2.4 2.4 0 0 0-.7-1.9c2.3-.3 4.7-1.1 4.7-5a3.9 3.9 0 0 0-1.1-2.7 3.6 3.6 0 0 0-.1-2.7s-.9-.3-2.9 1a10 10 0 0 0-5.2 0c-2-1.3-2.9-1-2.9-1a3.6 3.6 0 0 0-.1 2.7 3.9 3.9 0 0 0-1.1 2.7c0 3.9 2.4 4.7 4.7 5a2.4 2.4 0 0 0-.7 1.9v2.8" />
		</svg>
	)
}

/** A section's title, with an optional lede under it. */
export function SectionHeading({
	title,
	size = "lg",
	children,
}: {
	title: React.ReactNode
	size?: "md" | "lg"
	children?: React.ReactNode
}) {
	return (
		<div className="flex max-w-[640px] flex-col gap-3.5">
			<h2
				className={`font-mono leading-[1.12] font-medium tracking-[-0.03em] text-foam ${size === "lg" ? "text-[32px] sm:text-[40px]" : "text-[28px] sm:text-[32px]"}`}
			>
				{title}
			</h2>
			{children && <p className="text-base leading-relaxed text-mist">{children}</p>}
		</div>
	)
}

/** A shell command block; `children` is the command after the prompt. */
export function Command({ children }: { children: React.ReactNode }) {
	return (
		<pre className="m-0 overflow-x-auto rounded-md border border-line bg-abyss px-[18px] py-4 font-mono text-[13px] leading-[1.75] text-foam">
			<span className="text-silt">$ </span>
			{children}
		</pre>
	)
}

/** A one-line command with a copy button. */
export function CopyCommand({ command }: { command: string }) {
	const [copied, setCopied] = useState(false)
	const copy = () => {
		void navigator.clipboard.writeText(command).then(() => {
			setCopied(true)
			setTimeout(() => setCopied(false), 1500)
		})
	}
	return (
		<div className="flex h-10 min-w-0 items-center gap-2.5 rounded-sm border border-line bg-trench pr-1 pl-3.5">
			<code className="min-w-0 truncate font-mono text-[13px] text-foam">
				<span className="text-silt">$ </span>
				{command}
			</code>
			<button
				type="button"
				onClick={copy}
				aria-label={copied ? "Copied" : "Copy command"}
				className="flex size-8 shrink-0 items-center justify-center rounded-sm text-mist hover:bg-reef hover:text-foam"
			>
				{copied ? (
					<svg
						width="15"
						height="15"
						viewBox="0 0 20 20"
						fill="none"
						stroke="var(--signal-lumen)"
						strokeWidth="1.8"
						strokeLinecap="round"
						strokeLinejoin="round"
						aria-hidden="true"
					>
						<path d="M4 10.5l4 4 8-9" />
					</svg>
				) : (
					<svg
						width="15"
						height="15"
						viewBox="0 0 20 20"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
						aria-hidden="true"
					>
						<rect x="7" y="7" width="10" height="10" rx="1.5" />
						<path d="M13 7V4.5A1.5 1.5 0 0 0 11.5 3h-7A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13H7" />
					</svg>
				)}
			</button>
		</div>
	)
}

export function PrimaryLink({
	href,
	size = "md",
	children,
}: {
	href: string
	size?: "md" | "lg"
	children: React.ReactNode
}) {
	return (
		<a
			href={href}
			className={`inline-flex shrink-0 items-center rounded-sm bg-lumen font-semibold text-lumen-ink hover:bg-lumen/85 ${size === "lg" ? "h-12 px-5 text-[15px]" : "h-9 px-3.5 text-sm"}`}
		>
			{children}
		</a>
	)
}

export function SecondaryLink({
	href,
	size = "md",
	children,
}: {
	href: string
	size?: "md" | "lg"
	children: React.ReactNode
}) {
	return (
		<a
			href={href}
			className={`inline-flex shrink-0 items-center gap-2 rounded-sm border border-line-strong text-foam hover:border-mist/40 ${size === "lg" ? "h-12 px-5 text-[15px]" : "h-9 px-3 text-sm"}`}
		>
			{children}
		</a>
	)
}
