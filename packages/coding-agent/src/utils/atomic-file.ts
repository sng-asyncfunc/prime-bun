import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	fsyncSync,
	openSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const WIN32_RENAME_ATTEMPTS = 5;

function sleepSync(milliseconds: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function renameOntoSync(from: string, to: string): void {
	for (let attempt = 1; ; attempt++) {
		try {
			renameSync(from, to);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (
				process.platform !== "win32" ||
				(code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") ||
				attempt >= WIN32_RENAME_ATTEMPTS
			) {
				throw error;
			}
			sleepSync(10 * attempt);
		}
	}
}

export interface WriteFileAtomicOptions {
	mode?: number;
	fsync?: boolean;
	fsyncDir?: boolean;
	beforeRename?: (tempPath: string) => void;
}

export function writeFileAtomicSync(path: string, data: string, options: WriteFileAtomicOptions = {}): void {
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		const descriptor = options.mode === undefined ? openSync(tempPath, "wx") : openSync(tempPath, "wx", options.mode);
		try {
			const bytes = Buffer.from(data, "utf8");
			let offset = 0;
			while (offset < bytes.length) {
				const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
				if (written <= 0) throw new Error(`Short write persisting ${path}`);
				offset += written;
			}
			if (options.fsync) fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		if (options.mode !== undefined) chmodSync(tempPath, options.mode);
		options.beforeRename?.(tempPath);
		renameOntoSync(tempPath, path);
	} finally {
		rmSync(tempPath, { force: true });
	}
	if (options.fsyncDir) {
		try {
			const directoryDescriptor = openSync(dirname(path), "r");
			try {
				fsyncSync(directoryDescriptor);
			} finally {
				closeSync(directoryDescriptor);
			}
		} catch {
			// Some platforms cannot fsync directories; the rename remains atomic.
		}
	}
}

export function realpathIfPresentSync(path: string): string {
	try {
		return realpathSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	let current = path;
	for (let hop = 0; hop < 32; hop++) {
		let target: string;
		try {
			target = readlinkSync(current);
		} catch {
			return current;
		}
		let parent = dirname(current);
		try {
			parent = realpathSync(parent);
		} catch {
			// Resolve against the alias parent when the physical parent is unavailable.
		}
		current = resolve(parent, target);
	}
	throw new Error(`Too many symlink hops resolving ${path}`);
}
