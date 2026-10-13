import type {
	ModelCapability,
	ModelPurpose,
	WorkerModel,
} from "@shoal/protocol";
import {
	Eye,
	Hash,
	Image as ImageIcon,
	MessageSquare,
	Sparkles,
	Volume2,
	Wrench,
} from "lucide-react";
import type { ComponentType } from "react";

type IconType = ComponentType<{
	size?: number;
	className?: string;
	"aria-hidden"?: boolean;
}>;

const PURPOSE_ICON: Record<ModelPurpose, { Icon: IconType; label: string }> = {
	chat: { Icon: MessageSquare, label: "Chat" },
	embedding: { Icon: Hash, label: "Embedding" },
	image: { Icon: ImageIcon, label: "Image" },
	tts: { Icon: Volume2, label: "Text-to-Speech" },
};

const CAPABILITY_ICON: Record<
	ModelCapability,
	{ Icon: IconType; label: string }
> = {
	tools: { Icon: Wrench, label: "Tool calling" },
	vision: { Icon: Eye, label: "Vision" },
	thinking: { Icon: Sparkles, label: "Thinking" },
};

/**
 * Renders a single model as a pill, with optional leading purpose icon and
 * trailing capability icons. Icons are decorative (aria-hidden); the screen
 * reader gets the equivalent info via the chip's `title` attribute.
 *
 * `size` controls the visual density:
 *   - "sm" matches the inline chips on a worker card
 *   - "md" matches the homepage Available Models grid
 *
 * `loaded` tints the chip green when the model is currently resident on the
 * worker's backend (per the worker's residency probe). Defaults to false so
 * callers without per-worker context render a neutral chip.
 */
export function ModelChip({
	model,
	size = "sm",
	loaded = false,
}: {
	model: WorkerModel;
	size?: "sm" | "md";
	loaded?: boolean;
}) {
	const purpose = model.purpose ? PURPOSE_ICON[model.purpose] : null;
	const capabilities = model.capabilities ?? [];

	const sizing =
		size === "md"
			? { chip: "px-2.5 py-1 text-[13px] gap-1.5", icon: 13 }
			: { chip: "px-2 py-1 text-xs gap-1", icon: 12 };

	// A loaded model is raised and marked "hot" in Lumen; the rest sit flat.
	const tone = loaded
		? "border-line-strong bg-reef text-foam"
		: "border-line text-mist";

	const titleParts: string[] = [model.id];
	if (loaded) titleParts.push("Loaded");
	if (purpose) titleParts.push(purpose.label);
	for (const cap of capabilities) titleParts.push(CAPABILITY_ICON[cap].label);

	return (
		<span
			className={`inline-flex items-center rounded-xs border font-mono ${tone} ${sizing.chip}`}
			title={titleParts.join(" · ")}
		>
			{purpose && (
				<purpose.Icon
					size={sizing.icon}
					className="opacity-60"
					aria-hidden={true}
				/>
			)}
			<span>{model.id}</span>
			{capabilities.map((cap) => {
				const { Icon } = CAPABILITY_ICON[cap];
				return (
					<Icon
						key={cap}
						size={sizing.icon}
						className="opacity-60"
						aria-hidden={true}
					/>
				);
			})}
			{loaded && <span className="text-lumen">hot</span>}
		</span>
	);
}

