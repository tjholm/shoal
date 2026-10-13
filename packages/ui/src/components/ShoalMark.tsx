/** The shoal glyph at UI sizes: three fish, drawn in the current text
 *  colour, circling a Lumen hub. Below 20px the fish slim down with open
 *  tails so they don't clot. */
export function ShoalGlyph({
	size = 24,
	lit = true,
}: {
	size?: number;
	/** Light the hub in Lumen; off, the whole glyph is drawn in Mist. */
	lit?: boolean;
}) {
	const small = size < 20;
	const fish = small
		? "M7.5 4.5 C10 2.5 14 2.5 16.5 4.5 C14 6.5 10 6.5 7.5 4.5 Z M7.5 4.5 L5 2.5 M7.5 4.5 L5 6.5"
		: "M8 4 C10 1.4 14 1.4 16 4 C14 6.6 10 6.6 8 4 Z M8 4 L5.5 2 L5.5 6 Z";
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			strokeLinejoin="round"
			strokeLinecap={small ? "round" : undefined}
			aria-hidden="true"
		>
			<g stroke="currentColor" strokeWidth={small ? 2.1 : 1.4}>
				<path d={fish} />
				<path transform="rotate(120 12 12)" d={fish} />
				<path transform="rotate(240 12 12)" d={fish} />
			</g>
			<circle
				cx="12"
				cy="12"
				r={small ? 2.8 : 2.2}
				fill={lit ? "var(--signal-lumen)" : "currentColor"}
			/>
		</svg>
	);
}

/** Glyph plus the lowercase wordmark. */
export function ShoalWordmark() {
	return (
		<span className="flex items-center gap-2.5">
			<span className="flex text-mist">
				<ShoalGlyph size={22} />
			</span>
			<span className="font-mono text-[17px] font-medium tracking-[-0.03em] text-foam">
				shoal
			</span>
		</span>
	);
}
