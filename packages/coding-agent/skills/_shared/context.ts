import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface SkillContext {
	cwd: string;
	display: (mimeType: string, data: unknown) => void;
	hostRequest: (type: string, payload?: unknown) => Promise<unknown>;
}

export function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {};
	}
	return value as Record<string, unknown>;
}

export function expandPath(path: string, cwd: string): string {
	let expanded = path;
	if (expanded === "~") {
		expanded = homedir();
	} else if (expanded.startsWith("~/")) {
		expanded = join(homedir(), expanded.slice(2));
	}
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

export function requireString(value: unknown, name: string): string {
	if (typeof value !== "string") {
		throw new TypeError(`${name} must be a string`);
	}
	return value;
}

export function requireInteger(value: unknown, name: string): number {
	if (!Number.isInteger(value)) {
		throw new TypeError(`${name} must be an integer`);
	}
	return value as number;
}
