import { Config, Context, Effect, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

export interface EmailMessage {
	readonly to: string;
	readonly subject: string;
	readonly text: string;
	readonly html?: string;
}

export class EmailError extends Schema.TaggedError<EmailError>()("EmailError", {
	message: Schema.String,
	cause: Schema.optional(Schema.Defect()),
}) {}

/** Outbound mail, by `EMAIL_PROVIDER`: `console` (the default) logs each
 *  message, `resend` sends it through Resend from `EMAIL_FROM`. */
export class Email extends Context.Service<
	Email,
	{ send(message: EmailMessage): Effect.Effect<void, EmailError> }
>()("@shoal/api/Email") {
	static readonly layer = Layer.effect(
		Email,
		Effect.gen(function* () {
			const provider = yield* Config.Literals(["console", "resend"], "EMAIL_PROVIDER").pipe(
				Config.withDefault("console"),
			);
			switch (provider) {
				case "console":
					yield* Effect.log(
						"email: logging messages to the console (set EMAIL_PROVIDER=resend to send them)",
					);
					return Email.of({ send: logToConsole });
				case "resend":
					return yield* makeResend(
						yield* Config.Redacted("EMAIL_RESEND_API_KEY"),
						yield* Config.String("EMAIL_FROM"),
					);
			}
		}),
	);
}

const logToConsole = (message: EmailMessage) => {
	const divider = "─".repeat(64);
	return Effect.log(
		[
			"",
			`┌${divider}`,
			`│ [email:console] ${message.subject}`,
			`│ To: ${message.to}`,
			`├${divider}`,
			...message.text.split("\n").map((l) => `│ ${l}`),
			`└${divider}`,
		].join("\n"),
	);
};

const makeResend = Effect.fnUntraced(function* (
	apiKey: Redacted.Redacted,
	from: string,
) {
	const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
	return Email.of({
		send: (message) =>
			HttpClientRequest.post("https://api.resend.com/emails").pipe(
				HttpClientRequest.bearerToken(Redacted.value(apiKey)),
				HttpClientRequest.bodyJsonUnsafe({
					from,
					to: message.to,
					subject: message.subject,
					text: message.text,
					html: message.html,
				}),
				client.execute,
				Effect.asVoid,
				Effect.mapError(
					(cause) =>
						new EmailError({
							message: `Resend send failed: ${cause.message}`,
							cause,
						}),
				),
			),
	});
});
