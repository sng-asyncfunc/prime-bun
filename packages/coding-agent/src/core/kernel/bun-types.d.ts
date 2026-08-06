declare module "bun:jsc" {
	export function serialize(value: unknown): SharedArrayBuffer;
	export function deserialize(value: ArrayBuffer | SharedArrayBuffer | ArrayBufferView): unknown;
}

declare module "bun" {
	export interface ShellOutput {
		exitCode: number;
		stdout: Buffer;
		stderr: Buffer;
	}

	export interface ShellPromise extends Promise<ShellOutput> {
		cwd(directory: string): ShellPromise;
		env(environment: Record<string, string | undefined>): ShellPromise;
		nothrow(): ShellPromise;
		quiet(): ShellPromise;
	}

	export type Shell = (strings: TemplateStringsArray, ...expressions: unknown[]) => ShellPromise;

	export const $: Shell;
}

declare const Bun: {
	readonly version: string;
	stdout: unknown;
	stderr: unknown;
	write(destination: unknown, data: unknown, options?: unknown): Promise<number>;
	Transpiler: new (options: {
		loader: "ts";
		target: "bun";
		deadCodeElimination?: boolean;
	}) => {
		transformSync(source: string): string;
	};
	inspect(value: unknown, options?: { colors?: boolean; depth?: number }): string;
};
