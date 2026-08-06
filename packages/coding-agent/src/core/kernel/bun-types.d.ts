declare module "bun:jsc" {
	export function serialize(value: unknown): SharedArrayBuffer;
	export function deserialize(value: ArrayBuffer | SharedArrayBuffer | ArrayBufferView): unknown;
}
