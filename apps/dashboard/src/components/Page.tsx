/** A dashboard page: mono display title, a mono stats line, optional
 *  controls on the right, then sections spaced 24px apart. */
export function Page({
	title,
	stats,
	description,
	controls,
	children,
}: {
	title: string;
	/** Short facts under the title, e.g. `<Fact value="3">members</Fact>`. */
	stats?: React.ReactNode;
	/** A sentence under the title, for pages without stats. */
	description?: React.ReactNode;
	controls?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<main className="flex min-w-0 flex-col gap-6 px-5 pt-8 pb-16 sm:px-9">
			<div className="rise-in flex flex-wrap items-end justify-between gap-5">
				<div className="flex min-w-0 flex-col gap-2.5">
					<h1 className="font-mono text-[40px] leading-none font-medium tracking-[-0.03em] text-foam">
						{title}
					</h1>
					{stats && (
						<p className="flex flex-wrap gap-x-[18px] gap-y-1.5 font-mono text-[13px] text-mist">
							{stats}
						</p>
					)}
					{description && <p className="text-sm text-mist">{description}</p>}
				</div>
				{controls}
			</div>
			{children}
		</main>
	);
}

/** One fact in a page's stats line: the value in Foam, the rest in Mist. */
export function Fact({
	value,
	children,
}: {
	value: React.ReactNode;
	children?: React.ReactNode;
}) {
	return (
		<span>
			<span className="text-foam">{value}</span>
			{children && <> {children}</>}
		</span>
	);
}

/** A hairline panel with an optional titled header row. */
export function Section({
	title,
	caption,
	actions,
	label,
	children,
	className = "",
}: {
	title?: string;
	caption?: React.ReactNode;
	actions?: React.ReactNode;
	/** Accessible name when there's no visible title. */
	label?: string;
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<section
			aria-label={title ? undefined : label}
			className={`rise-in min-w-0 overflow-hidden rounded-md border border-line bg-shelf ${className}`}
		>
			{(title || actions) && (
				<div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-[18px] py-3.5">
					<div className="flex flex-col gap-0.5">
						{title && <h2 className="text-[15px] font-semibold text-foam">{title}</h2>}
						{caption && <span className="text-xs text-mist">{caption}</span>}
					</div>
					{actions}
				</div>
			)}
			{children}
		</section>
	);
}

/** Column headings for a grid table: mono labels in Silt. */
export function TableHead({
	columns,
	children,
}: {
	columns: string;
	children: React.ReactNode;
}) {
	return (
		<div
			className="grid gap-4 border-b border-line px-[18px] py-2.5 font-mono text-[10.5px] tracking-[0.08em] text-silt uppercase"
			style={{ gridTemplateColumns: columns }}
		>
			{children}
		</div>
	);
}
