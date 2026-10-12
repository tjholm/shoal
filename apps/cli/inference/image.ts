import type { GeneratedImage, ImageOptions } from "@shoal/protocol";
import { Effect, Schema } from "effect";
import { postJson } from "./backend";

const ImageResponse = Schema.Struct({
	data: Schema.Array(
		Schema.Struct({
			b64_json: Schema.optionalKey(Schema.String),
			url: Schema.optionalKey(Schema.String),
			revised_prompt: Schema.optionalKey(Schema.String),
		}),
	),
});

export const imageInference = (
	backendUrl: string,
	model: string,
	prompt: string,
	options: ImageOptions | undefined,
) =>
	postJson(
		`${backendUrl}/v1/images/generations`,
		{
			model,
			prompt,
			size: options?.size,
			n: options?.n,
			quality: options?.quality,
			style: options?.style,
			response_format: options?.responseFormat,
		},
		ImageResponse,
	).pipe(
		Effect.map((json) =>
			json.data.map(
				(d): GeneratedImage => ({
					...(d.b64_json !== undefined ? { b64: d.b64_json } : {}),
					...(d.url !== undefined ? { url: d.url } : {}),
					...(d.revised_prompt !== undefined
						? { revisedPrompt: d.revised_prompt }
						: {}),
				}),
			),
		),
	);
