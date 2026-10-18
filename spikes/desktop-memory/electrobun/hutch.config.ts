// @hutch cli=0.27.1 cottontail=0.7.1
export default {
	packageManager: { name: "bun", executable: "bun" },
	scripts: {
		install: ["hutch", "install"],
		build: "hutch electrobun prepare && hutch electrobun build --env=stable",
	},
	electrobun: {
		version: "2.0.2",
	},
};
