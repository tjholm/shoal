import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const socketPath =
	process.platform === "win32"
		? `\\\\.\\pipe\\school.shoal.desktop-${os.userInfo().username}`
		: path.join(process.env.XDG_RUNTIME_DIR ?? os.tmpdir(), `school.shoal.desktop-${os.userInfo().uid}.sock`);

/** Claims this user's single running copy of the app. When another copy
 *  already runs, asks it to call `onOpen` and resolves to false. */
export const claimSingleInstance = async (onOpen: () => void): Promise<boolean> => {
	const told = await Bun.connect({
		unix: socketPath,
		socket: { data() {}, open: (socket) => void socket.end("open") },
	}).then(
		() => true,
		() => false,
	);
	if (told) return false;
	// Left behind by a copy that crashed.
	if (process.platform !== "win32") rmSync(socketPath, { force: true });
	Bun.listen({
		unix: socketPath,
		socket: {
			data: (_socket, data) => {
				if (data.toString() === "open") onOpen();
			},
		},
	});
	return true;
};
