export type WorkerStatus = "online" | "busy" | "offline";

/** Whether a worker is connected, and if so whether it has spare capacity. */
export function workerStatus(worker: {
	online: boolean;
	inFlight: number;
	maxConcurrent: number | null;
}): WorkerStatus {
	if (!worker.online) return "offline";
	return worker.maxConcurrent !== null && worker.inFlight >= worker.maxConcurrent
		? "busy"
		: "online";
}

/** A worker's state as a wash badge. Each state has its own glyph as well as
 *  its colour, so it survives colour blindness and greyscale. */
export function StatusBadge({
	status,
	label,
}: {
	status: WorkerStatus;
	label?: string;
}) {
	const tone = {
		online: "border-lumen-edge bg-lumen-wash text-lumen",
		busy: "border-amber-edge bg-amber-wash text-amber",
		offline: "border-coral-edge bg-coral-wash text-coral",
	}[status];
	return (
		<span
			className={`inline-flex h-6 shrink-0 items-center gap-1.5 rounded-xs border px-2 font-mono text-xs ${tone}`}
		>
			<StatusGlyph status={status} />
			{label ?? status}
		</span>
	);
}

/** The bare status glyph: a pulsing live dot, an amber diamond for a worker
 *  at capacity, or a coral cross for offline. */
export function StatusGlyph({ status }: { status: WorkerStatus }) {
	switch (status) {
		case "online":
			return (
				<span
					aria-hidden="true"
					className="live-pulse size-1.5 shrink-0 rounded-full bg-lumen"
				/>
			);
		case "busy":
			return (
				<span
					aria-hidden="true"
					className="size-1.5 shrink-0 rotate-45 bg-amber"
				/>
			);
		case "offline":
			return (
				<span aria-hidden="true" className="shrink-0 text-[11px] leading-none text-coral">
					×
				</span>
			);
	}
}
