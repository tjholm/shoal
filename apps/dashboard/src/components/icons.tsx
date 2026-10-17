import type { ModelPurpose } from "@shoal/protocol";

/** Icons on the design system's 20px grid, 1.5 stroke, in currentColor. */
function Icon({
	size = 16,
	strokeWidth = 1.5,
	children,
}: {
	size?: number;
	strokeWidth?: number;
	children: React.ReactNode;
}) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 20 20"
			fill="none"
			stroke="currentColor"
			strokeWidth={strokeWidth}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{children}
		</svg>
	);
}

export const OverviewIcon = () => (
	<Icon>
		<rect x="3" y="3" width="6" height="6" rx="1" />
		<rect x="11" y="3" width="6" height="6" rx="1" />
		<rect x="3" y="11" width="6" height="6" rx="1" />
		<rect x="11" y="11" width="6" height="6" rx="1" />
	</Icon>
);

export const ModelsIcon = () => (
	<Icon>
		<path d="M10 2.5 16.5 6v8L10 17.5 3.5 14V6z" />
		<path d="M3.5 6 10 9.5 16.5 6M10 9.5v8" />
	</Icon>
);

export const MembersIcon = () => (
	<Icon>
		<circle cx="8" cy="7" r="3" />
		<path d="M2.5 16.5c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5M13.5 4.2a3 3 0 0 1 0 5.6M15.5 12.5c1 .7 1.7 2 2 4" />
	</Icon>
);

export const KeyIcon = () => (
	<Icon>
		<circle cx="7" cy="13" r="3.5" />
		<path d="m9.5 10.5 7-7M14 6l2 2M12 8l1.5 1.5" />
	</Icon>
);

export const PlusIcon = ({ size = 14 }: { size?: number }) => (
	<Icon size={size} strokeWidth={2}>
		<path d="M10 4v12M4 10h12" />
	</Icon>
);

export const ChevronIcon = ({ open }: { open: boolean }) => (
	<span
		className="inline-flex text-silt transition-transform duration-200"
		style={{ transform: open ? "rotate(90deg)" : undefined }}
	>
		<Icon strokeWidth={1.6}>
			<path d="m7 5 5 5-5 5" />
		</Icon>
	</span>
);

export const ToolsIcon = () => (
	<Icon size={11} strokeWidth={1.8}>
		<path d="M12.5 3.5a4 4 0 0 0-4.6 5.3L3.5 13.2a1.6 1.6 0 0 0 2.3 2.3l4.4-4.4a4 4 0 0 0 5.3-4.6l-2.4 2.4-2.1-.5-.5-2.1Z" />
	</Icon>
);

export const VisionIcon = ({ size = 11 }: { size?: number }) => (
	<Icon size={size} strokeWidth={size < 14 ? 1.8 : 1.5}>
		<path d="M2.5 10s2.7-5 7.5-5 7.5 5 7.5 5-2.7 5-7.5 5-7.5-5-7.5-5Z" />
		<circle cx="10" cy="10" r="2.2" />
	</Icon>
);

/** What a model is for, as the design system names it. */
export const KIND_LABEL: Record<ModelPurpose, string> = {
	chat: "text",
	embedding: "embedding",
	image: "image",
	tts: "speech",
};

export function KindIcon({
	purpose,
	size = 14,
}: {
	purpose: ModelPurpose | undefined;
	size?: number;
}) {
	const strokeWidth = size < 14 ? 1.7 : 1.5;
	switch (purpose) {
		case "image":
			return (
				<Icon size={size} strokeWidth={strokeWidth}>
					<rect x="3" y="4" width="14" height="12" rx="1.5" />
					<circle cx="7.5" cy="8.5" r="1.3" />
					<path d="m17 13-4-4-8 7" />
				</Icon>
			);
		case "tts":
			return (
				<Icon size={size} strokeWidth={strokeWidth}>
					<path d="M3 8v4M6.5 5.5v9M10 3v14M13.5 6.5v7M17 8.5v3" />
				</Icon>
			);
		case "embedding":
			return (
				<Icon size={size} strokeWidth={strokeWidth}>
					<circle cx="5" cy="14" r="1.5" />
					<circle cx="10" cy="6" r="1.5" />
					<circle cx="15" cy="12" r="1.5" />
					<path d="M6.2 12.7 8.8 7.3M11.4 7l2.3 3.8" />
				</Icon>
			);
		default:
			return (
				<Icon size={size} strokeWidth={strokeWidth}>
					<path d="M4 4.5h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H9l-3.5 3v-3H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z" />
				</Icon>
			);
	}
}
