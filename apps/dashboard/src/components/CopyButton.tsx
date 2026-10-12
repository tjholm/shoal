import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/utils";

/** An icon button that copies `value`, confirming with a check for a moment. */
export function CopyButton({
	value,
	label,
	className = "",
}: {
	value: string;
	label: string;
	className?: string;
}) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			aria-label={copied ? "Copied" : label}
			title={label}
			onClick={async () => {
				await navigator.clipboard.writeText(value);
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			}}
			className={cn(
				"flex size-7 shrink-0 items-center justify-center rounded-xs text-mist hover:bg-reef hover:text-foam",
				className,
			)}
		>
			{copied ? (
				<Check className="size-3.5 text-lumen" aria-hidden="true" />
			) : (
				<Copy className="size-3.5" aria-hidden="true" />
			)}
		</button>
	);
}
