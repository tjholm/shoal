import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { Command } from "effect/cli";
import { workerCommand } from "./commands/worker";

// Replaced at bundle time by `bun build --define` in the publish workflow.
declare const __SHOAL_VERSION__: string | undefined;

Command.make("shoal").pipe(
	Command.withDescription("Shoal CLI"),
	Command.withSubcommands([workerCommand]),
	Command.run({
		version:
			typeof __SHOAL_VERSION__ === "string" ? __SHOAL_VERSION__ : "dev",
	}),
	Effect.provide(NodeServices.layer),
	NodeRuntime.runMain,
);
