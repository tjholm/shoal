import { Effect, Schema } from "effect";
import { postJson } from "./backend";

const EmbeddingResponse = Schema.Struct({
	data: Schema.Array(Schema.Struct({ embedding: Schema.Array(Schema.Number) })),
});

export const embeddingInference = (
	backendUrl: string,
	model: string,
	input: string | ReadonlyArray<string>,
) =>
	postJson(
		`${backendUrl}/v1/embeddings`,
		{ model, input },
		EmbeddingResponse,
	).pipe(Effect.map((json) => json.data.map((d) => d.embedding)));
