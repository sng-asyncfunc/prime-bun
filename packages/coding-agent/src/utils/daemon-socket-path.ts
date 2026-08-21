import { resolve } from "node:path";

export function normalizeSocketPath(socketPath: string, baseDir?: string): string {
	if (process.platform === "win32") {
		return socketPath.toLowerCase();
	}
	return baseDir ? resolve(baseDir, socketPath) : resolve(socketPath);
}
