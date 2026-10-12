import type { AnyFieldApi } from "@tanstack/react-form";

interface TextFieldProps {
	field: AnyFieldApi;
	label?: string;
	type?: "text" | "email" | "password";
	placeholder?: string;
	disabled?: boolean;
	required?: boolean;
	className?: string;
}

/**
 * Standard styled text input bound to a TanStack Form field.
 * Surfaces field-level errors below the input.
 */
export function TextField({
	field,
	label,
	type = "text",
	placeholder,
	disabled,
	required,
	className,
}: TextFieldProps) {
	const errors = field.state.meta.errors as Array<
		string | { message?: string } | undefined
	>;
	const errorMessage =
		field.state.meta.isTouched && errors.length > 0
			? typeof errors[0] === "string"
				? errors[0]
				: errors[0]?.message
			: null;

	return (
		<label className={className ?? "block"}>
			{label && (
				<span className="mb-1 block text-sm font-semibold text-[var(--sea-ink-soft)]">
					{label}
				</span>
			)}
			<input
				id={field.name}
				name={field.name}
				type={type}
				value={field.state.value ?? ""}
				onChange={(e) => field.handleChange(e.target.value)}
				onBlur={field.handleBlur}
				placeholder={placeholder}
				disabled={disabled}
				required={required}
				className="w-full rounded-sm border border-[var(--line)] bg-[var(--surface-strong)] px-4 py-2.5 text-sm text-[var(--sea-ink)] focus:border-[var(--lagoon)] focus:outline-none disabled:opacity-50"
			/>
			{errorMessage && (
				<span className="mt-1 block text-xs text-coral">{errorMessage}</span>
			)}
		</label>
	);
}
