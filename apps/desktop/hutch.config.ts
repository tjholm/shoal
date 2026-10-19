// @hutch cli=0.27.1 cottontail=0.7.1
export default {
	// Dependencies live in the repo's bun workspace (root bun.lock), not hutch.lock.
	packageManager: { name: "bun", executable: "bun" },
	electrobun: {
		version: "2.0.2",
	},
};
