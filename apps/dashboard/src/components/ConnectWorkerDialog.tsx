import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { serverConfigQuery } from "../lib/queries";
import { ConnectSteps } from "./ConnectWorker";
import { PlusIcon } from "./icons";
import { Button } from "./ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "./ui/dialog";

/** The header's Connect worker action: create a token and copy the worker
 *  command, without leaving the page. */
export function ConnectWorkerDialog() {
	const [open, setOpen] = useState(false);
	const { data: config } = useQuery(serverConfigQuery());
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button size="sm" className="hidden sm:inline-flex">
					<PlusIcon />
					Connect worker
				</Button>
			</DialogTrigger>
			<DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>Connect a worker</DialogTitle>
					<DialogDescription>
						Any machine that can reach this server. It dials out; nothing to open.
					</DialogDescription>
				</DialogHeader>
				{/* Remounted on each open, so a new token is never reused by accident. */}
				{open && config && <ConnectSteps serverWsUrl={config.serverWsUrl} />}
			</DialogContent>
		</Dialog>
	);
}
