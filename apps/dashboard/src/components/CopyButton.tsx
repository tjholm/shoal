import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { cn } from "@shoal/ui/lib/utils";

/**
 * Copy `text` to the clipboard. The Clipboard API exists only in secure
 * contexts, so a dashboard served over plain http on a LAN address falls back
 * to selecting a hidden textarea and `execCommand("copy")`. The textarea goes
 * beside `anchor` rather than on `body`, so a dialog's focus trap can't stop
 * it being selected.
 */
async function copyText(text: string, anchor: HTMLElement): Promise<boolean> {
	if (navigator.clipboard) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			// Denied permission; try the fallback.
		}
	}
	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "");
	textarea.style.position = "fixed";
	textarea.style.opacity = "0";
	anchor.after(textarea);
	textarea.select();
	try {
		return document.execCommand("copy");
	} finally {
		textarea.remove();
		anchor.focus();
	}
}

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
			onClick={async (event) => {
				if (!(await copyText(value, event.currentTarget))) return;
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
