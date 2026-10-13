import { Button } from "@shoal/ui/components/button";
import { useState } from "react";
import type { BackendState, WorkerState } from "../shared/rpc";
import { rpc } from "./rpc";
import { Body, Card, Chip, DIALECT_NAME, Dot, describeModel, Empty, PageTitle, Row } from "./ui";

/** Every model, grouped by the backend serving it. */
export function Models({ state }: { state: WorkerState }) {
	const [error, setError] = useState<string | null>(null);
	// Jobs for a model go to the first backend listing it; later copies are never used.
	const servedEarlier = new Set<string>();
	return (
		<Body>
			<PageTitle>Models</PageTitle>
			{error && (
				<p role="alert" className="m-0 text-sm text-coral">
					{error}
				</p>
			)}
			{state.backends.length === 0 && <p className="m-0 text-sm text-silt">No backends configured yet.</p>}
			{state.backends.map((backend) => {
				const shadowed = new Set(servedEarlier);
				for (const model of backend.models) servedEarlier.add(model.id);
				return (
					<section key={backend.url} className="flex flex-col gap-2.5">
						<BackendHeader backend={backend} />
						{backend.error ? (
							<Empty>{backend.error}</Empty>
						) : backend.models.length === 0 ? (
							<Empty>No models.</Empty>
						) : (
							<Card>
								{backend.models.map((model) => {
									const loaded = backend.loaded.includes(model.id);
									return (
										<Row key={model.id}>
											<Dot tone="lumen" hollow={!loaded} />
											<span className="min-w-0 flex-1 truncate font-mono text-[13px]">{model.id}</span>
											<span className="text-xs text-mist">
												{shadowed.has(model.id) ? "served by an earlier backend" : describeModel(model)}
											</span>
											{loaded && backend.canUnload && (
												<Button
													variant="outline"
													size="xs"
													onClick={async () =>
														setError(await rpc.request.unloadModel({ backend: backend.url, id: model.id }))
													}
												>
													Unload
												</Button>
											)}
											<span className={`w-[74px] text-right text-xs ${loaded ? "text-lumen" : "text-silt"}`}>
												{loaded ? "Loaded" : "Idle"}
											</span>
										</Row>
									);
								})}
							</Card>
						)}
					</section>
				);
			})}
		</Body>
	);
}

export function BackendHeader({ backend }: { backend: BackendState }) {
	return (
		<div className="flex items-center gap-2">
			<span className="text-sm font-medium">{backend.dialect ? DIALECT_NAME[backend.dialect] : "Backend"}</span>
			<span className="font-mono text-xs text-silt">{backend.url}</span>
			<span className="flex-1" />
			<BackendChip backend={backend} />
		</div>
	);
}

export function BackendChip({ backend }: { backend: BackendState }) {
	if (backend.dialect !== null) return <Chip tone="lumen">Reachable</Chip>;
	if (backend.error !== null) return <Chip tone="coral">Not responding</Chip>;
	return <Chip tone="silt">Not probed yet</Chip>;
}
