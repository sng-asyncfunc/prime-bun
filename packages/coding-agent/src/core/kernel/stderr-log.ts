import { type FileHandle, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export interface KernelStderrLogOptions {
	maxBytes?: number;
	onError?: (error: Error) => void;
}

export class KernelStderrLog {
	private readonly maxBytes: number;
	private readonly onError?: (error: Error) => void;
	private handle?: FileHandle;
	private bytes = 0;
	private initialized = false;
	private disabled = false;
	private closed = false;
	private queue: Promise<void> = Promise.resolve();
	private closePromise?: Promise<void>;

	constructor(
		private readonly path: string,
		options: KernelStderrLogOptions = {},
	) {
		this.maxBytes = Math.max(1, Math.floor(options.maxBytes ?? DEFAULT_MAX_BYTES));
		this.onError = options.onError;
	}

	append(chunk: string): void {
		if (this.closed || this.disabled || chunk.length === 0) return;
		const input = Buffer.from(chunk);
		const data = input.byteLength > this.maxBytes ? input.subarray(input.byteLength - this.maxBytes) : input;
		this.queue = this.queue.then(() => this.write(data)).catch((error: unknown) => this.disable(error));
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closed = true;
		this.closePromise = (async () => {
			await this.queue;
			await this.closeHandle();
		})();
		return this.closePromise;
	}

	dispose(): void {
		void this.close();
	}

	private async write(data: Buffer): Promise<void> {
		await this.ensureOpen();
		if (!this.handle) return;
		if (this.bytes > 0 && this.bytes + data.byteLength > this.maxBytes) {
			await this.rotate();
		}
		if (!this.handle) return;
		let offset = 0;
		while (offset < data.byteLength) {
			const { bytesWritten } = await this.handle.write(data, offset, data.byteLength - offset, null);
			if (bytesWritten <= 0) throw new Error(`Unable to append Bun kernel diagnostics to ${this.path}`);
			offset += bytesWritten;
		}
		this.bytes += data.byteLength;
	}

	private async ensureOpen(): Promise<void> {
		if (this.initialized) return;
		this.initialized = true;
		await mkdir(dirname(this.path), { recursive: true });
		let existingBytes = 0;
		try {
			existingBytes = (await stat(this.path)).size;
		} catch (error) {
			if (!isMissingFile(error)) throw error;
		}
		if (existingBytes >= this.maxBytes) {
			await replaceRotatedFile(this.path);
			existingBytes = 0;
		}
		this.handle = await open(this.path, "a");
		this.bytes = existingBytes;
	}

	private async rotate(): Promise<void> {
		await this.closeHandle();
		await replaceRotatedFile(this.path);
		this.handle = await open(this.path, "a");
		this.bytes = 0;
	}

	private async closeHandle(): Promise<void> {
		const handle = this.handle;
		this.handle = undefined;
		if (handle) await handle.close();
	}

	private async disable(error: unknown): Promise<void> {
		this.disabled = true;
		try {
			await this.closeHandle();
		} catch {}
		this.onError?.(error instanceof Error ? error : new Error(String(error)));
	}
}

function isMissingFile(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function replaceRotatedFile(path: string): Promise<void> {
	const rotatedPath = `${path}.old`;
	try {
		await unlink(rotatedPath);
	} catch (error) {
		if (!isMissingFile(error)) throw error;
	}
	try {
		await rename(path, rotatedPath);
	} catch (error) {
		if (!isMissingFile(error)) throw error;
	}
}
