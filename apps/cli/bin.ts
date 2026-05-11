import { defineCommand, runMain } from "citty";
import { workerCommand } from "./commands/worker";

const main = defineCommand({
  meta: {
    name: "shoal",
    description: "Shoal CLI",
  },
  subCommands: {
    worker: workerCommand,
  },
});

runMain(main);
