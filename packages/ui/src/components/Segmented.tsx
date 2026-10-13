/** A segmented tab control: one of a few mutually exclusive views. */
export function Segmented<Value extends string>({
	label,
	value,
	options,
	onChange,
	size = "md",
}: {
	label: string;
	value: Value;
	options: ReadonlyArray<{ value: Value; label: string; count?: number }>;
	onChange: (value: Value) => void;
	size?: "sm" | "md";
}) {
	return (
		<div
			role="tablist"
			aria-label={label}
			className="flex gap-0.5 rounded-sm border border-line bg-trench p-[3px]"
		>
			{options.map((option) => {
				const selected = option.value === value;
				return (
					<button
						key={option.value}
						type="button"
						role="tab"
						aria-selected={selected}
						onClick={() => onChange(option.value)}
						className={`rounded-xs border px-3 font-mono text-xs ${size === "sm" ? "h-[26px] px-2.5" : "h-[30px]"} ${
							selected
								? "border-line-strong bg-reef text-foam"
								: "border-transparent text-mist hover:text-foam"
						}`}
					>
						{option.label}
						{option.count !== undefined && (
							<span className="ml-1.5 text-silt">{option.count}</span>
						)}
					</button>
				);
			})}
		</div>
	);
}
