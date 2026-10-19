import { FitNumber } from "@shoal/ui/components/FitNumber";
import { clock, elapsed } from "../shared/format";
import type { FinishedJob, WorkerState } from "../shared/rpc";
import { Body, Card, Chip, Dot, Empty, PageTitle, Row, TASK_NAME, type Tone } from "./ui";

const OUTCOME: Record<FinishedJob["outcome"]["_tag"], { label: string; tone: Tone }> = {
	Done: { label: "done", tone: "lumen" },
	Failed: { label: "failed", tone: "coral" },
	Cancelled: { label: "cancelled", tone: "silt" },
	Abandoned: { label: "abandoned", tone: "amber" },
};

/** Jobs that have ended, newest first. */
export function Activity({ state }: { state: WorkerState }) {
	return (
		<Body>
			<div className="flex flex-col gap-1.5">
				<PageTitle>Activity</PageTitle>
				<p className="m-0 text-sm text-mist">The last 50 jobs since Shoal started.</p>
			</div>
			{state.recent.length === 0 ? (
				<Empty>No jobs yet.</Empty>
			) : (
				<Card>
					{state.recent.map((job) => {
						const { label, tone } = OUTCOME[job.outcome._tag];
						return (
							<Row key={`${job.endedAt}-${job.model}-${job.durationMs}`} className="items-start">
								<span className="pt-[5px]">
									<Dot tone={tone} />
								</span>
								<div className="flex min-w-0 flex-1 flex-col gap-1">
									<div className="flex items-center gap-2">
										<span className="truncate font-mono text-[13px]">{job.model}</span>
										<span className="text-xs text-silt">{TASK_NAME[job.task]}</span>
										<Chip tone={tone}>{label}</Chip>
									</div>
									{job.outcome._tag === "Failed" && <span className="text-xs text-mist">{job.outcome.message}</span>}
								</div>
								<span className="flex w-[100px] flex-none gap-1 font-mono text-[13px] text-mist">
									<FitNumber value={job.tokens} className="flex-1 text-right" /> tokens
								</span>
								<span className="w-16 flex-none font-mono text-[13px] text-silt">{elapsed(job.durationMs)}</span>
								<span className="w-[110px] flex-none text-right font-mono text-[13px] text-silt">{clock(job.endedAt)}</span>
							</Row>
						);
					})}
				</Card>
			)}
		</Body>
	);
}
