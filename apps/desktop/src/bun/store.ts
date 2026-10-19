import type { SettingsStore } from "@shoal/client-core/settings";
import { Updater, Utils } from "electrobun/main";

const { identifier, channel } = await Updater.getLocalInfo();
// Electrobun reports blanks when it can't read version.json; every channel would then share one folder.
if (identifier === "" || channel === "") throw new Error("Couldn't read this build's identifier and channel from version.json.");

/** This build's settings, identity and API keys. Each channel has its own, so a dev build never touches an installed copy's. */
export const store: SettingsStore = {
	dir: Utils.paths.userData,
	credentialService: `${identifier}.${channel}`,
};
