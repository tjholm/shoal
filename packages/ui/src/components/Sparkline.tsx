const TONE = {
	lumen: { strong: "bg-lumen", soft: "bg-lumen/35" },
	amber: { strong: "bg-amber", soft: "bg-amber/35" },
	coral: { strong: "bg-coral", soft: "bg-coral/35" },
};

/** Tiny bar chart: the latest bar at full strength, the rest at 35%. Empty
 *  buckets keep a sliver so the baseline reads. */
export function Sparkline({
	values,
	height = 24,
	tone = "lumen",
}: {
	values: ReadonlyArray<number>;
	height?: number;
	tone?: keyof typeof TONE;
}) {
	const max = Math.max(1, ...values);
	const { strong, soft } = TONE[tone];
	return (
		<span aria-hidden="true" className="flex items-end gap-0.5" style={{ height }}>
			{values.map((value, i) => (
				<span
					// biome-ignore lint/suspicious/noArrayIndexKey: positional buckets
					key={i}
					className={`flex-1 rounded-t-[1px] ${
						value === 0 ? "bg-reef" : i === values.length - 1 ? strong : soft
					}`}
					style={{ height: `${Math.max(6, Math.round((value / max) * 100))}%` }}
				/>
			))}
		</span>
	);
}
