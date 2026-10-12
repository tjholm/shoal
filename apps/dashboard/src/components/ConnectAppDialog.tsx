import { useState } from "react";
import { CopyButton } from "./CopyButton";
import { CreateKeyStep, Step, Steps } from "./Steps";
import { Button } from "./ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "./ui/dialog";

/** The header's Connect your app action: create a key and copy a working
 *  request for any OpenAI client. */
export function ConnectAppDialog() {
	const [open, setOpen] = useState(false);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button variant="secondary" size="sm" className="hidden sm:inline-flex">
					Connect your app
				</Button>
			</DialogTrigger>
			<DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>Connect your app</DialogTitle>
					<DialogDescription>
						Use your workers' models from the chat apps and tools you already have.
					</DialogDescription>
				</DialogHeader>
				{/* Remounted on each open, so a new key is never reused by accident. */}
				{open && <ConnectAppSteps />}
			</DialogContent>
		</Dialog>
	);
}

function ConnectAppSteps() {
	const [key, setKey] = useState<string | undefined>();
	const apiUrl = `${window.location.origin}/api/v1`;

	return (
		<Steps>
			<CreateKeyStep
				title="Create an API key"
				defaultName="app"
				description="An API key scoped to this organization. Name it after the app that will use it."
				created={key}
				onCreated={setKey}
			/>
			<Step n={2} done={false} last>
				<div className="flex flex-col gap-1">
					<span className="text-[15px] font-semibold text-foam">Add shoal to your chat app</span>
					<span className="text-[13px] text-mist">
						In your app's settings, add an <span className="text-foam">OpenAI-compatible</span>{" "}
						provider (some apps call it "Custom OpenAI" or "OpenAI API"), then copy these two
						things into it. Your app will list the available models once they're in.
					</span>
				</div>
				<div className="flex flex-col overflow-hidden rounded-sm border border-line">
					<Setting
						label="Base URL"
						aka="also called API URL, endpoint or API base"
						value={apiUrl}
					/>
					<Setting
						label="API key"
						aka="also called token or secret"
						value={key}
						missing="Create a key in step 1"
					/>
				</div>
				<span className="text-xs text-silt">
					Works with chat apps that let you add your own OpenAI-compatible provider, such as Open
					WebUI, LibreChat, Jan, Msty and Chatbox.
				</span>
			</Step>
		</Steps>
	);
}

/** One value to copy into an app's settings, with the names apps use for
 *  it. */
function Setting({
	label,
	aka,
	value,
	missing,
}: {
	label: string;
	aka: string;
	value: string | undefined;
	missing?: string;
}) {
	return (
		<div className="grid grid-cols-1 items-center gap-x-4 gap-y-1.5 border-b border-line bg-trench px-3.5 py-3 last:border-b-0 sm:grid-cols-[170px_minmax(0,1fr)]">
			<span className="flex flex-col gap-0.5">
				<span className="text-[13px] font-medium text-foam">{label}</span>
				<span className="text-[11.5px] leading-snug text-silt">{aka}</span>
			</span>
			<span className="flex min-w-0 items-center gap-2">
				{value === undefined ? (
					<span className="font-mono text-[12.5px] text-amber">{missing}</span>
				) : (
					<span className="min-w-0 truncate font-mono text-[12.5px] text-foam">{value}</span>
				)}
				{value !== undefined && (
					<CopyButton value={value} label={`Copy ${label.toLowerCase()}`} className="ml-auto" />
				)}
			</span>
		</div>
	);
}
