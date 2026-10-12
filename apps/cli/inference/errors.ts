import { Schema } from "effect";

/** A backend request failed: transport error, non-2xx status, or a response
 *  body that didn't match the shape we expect. */
export class BackendError extends Schema.TaggedError<BackendError>()(
	"BackendError",
	{
		url: Schema.String,
		message: Schema.String,
		cause: Schema.optional(Schema.Defect()),
	},
) {}

export class NoBackendForModel extends Schema.TaggedError<NoBackendForModel>()(
	"NoBackendForModel",
	{
		model: Schema.String,
		knownModels: Schema.Array(Schema.String),
	},
) {
	get message(): string {
		return (
			`No configured backend serves model "${this.model}". ` +
			(this.knownModels.length > 0
				? `Known models: ${this.knownModels.join(", ")}`
				: "No backends reported any models.")
		);
	}
}
