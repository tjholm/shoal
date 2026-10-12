import { Schema } from "effect";

/**
 * A `/v1/models` entry, with every dialect-specific field the detectors read.
 * Unknown fields are ignored on decode, so one schema serves every backend.
 */
export const RawModelEntry = Schema.Struct({
	id: Schema.String,
	owned_by: Schema.optionalKey(Schema.String),
	// Lemonade
	recipe: Schema.optionalKey(Schema.String),
	labels: Schema.optionalKey(Schema.Array(Schema.String)),
	max_context_window: Schema.optionalKey(Schema.Number),
	// LM Studio
	type: Schema.optionalKey(Schema.String),
	arch: Schema.optionalKey(Schema.String),
	state: Schema.optionalKey(Schema.String),
	// vLLM
	permission: Schema.optionalKey(Schema.Array(Schema.Unknown)),
	max_model_len: Schema.optionalKey(Schema.Number),
});
export type RawModelEntry = typeof RawModelEntry.Type;

export const ModelsResponse = Schema.Struct({
	data: Schema.Array(RawModelEntry),
});
