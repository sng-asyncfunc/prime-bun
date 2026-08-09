export const BUN_WORKER_PROTOCOL_VERSION = 5;

interface BunWorkerProtocolMessage {
	id: string;
	protocolVersion: typeof BUN_WORKER_PROTOCOL_VERSION;
	type: string;
}

export interface InitializeBunWorkerMessage extends BunWorkerProtocolMessage {
	type: "initialize";
	bunPath: string;
	cwd: string;
	kernelDirectory: string;
	commandPrefix: string;
	shell: {
		executable: string;
		args: string[];
	};
	skillFactoryTimeoutMs: number;
	skills: Array<{
		name: string;
		globalName: string;
		entryPath: string;
		unavailableReason?: string;
	}>;
}

export interface ExecuteBunCellMessage extends BunWorkerProtocolMessage {
	type: "execute";
	cellId: string;
	code: string;
	maxResultChars?: number;
}

export interface ListBunWorkerNamesMessage extends BunWorkerProtocolMessage {
	type: "list_names";
}

export interface SnapshotBunWorkerMessage extends BunWorkerProtocolMessage {
	type: "snapshot";
	path: string;
	manifestPath: string;
	maxBytes: number;
	includeRuntimeState: boolean;
	persistentMirror?: {
		path: string;
		manifestPath: string;
	};
}

export interface RestoreBunWorkerMessage extends BunWorkerProtocolMessage {
	type: "restore";
	path: string;
	required?: boolean;
}

export interface BunWorkerHostResponseMessage extends BunWorkerProtocolMessage {
	type: "host_response";
	requestId: string;
	value?: unknown;
	error?: {
		name: string;
		message: string;
	};
}

export interface ShutdownBunWorkerMessage extends BunWorkerProtocolMessage {
	type: "shutdown";
}

export type HostToBunWorkerMessage =
	| InitializeBunWorkerMessage
	| ExecuteBunCellMessage
	| ListBunWorkerNamesMessage
	| SnapshotBunWorkerMessage
	| RestoreBunWorkerMessage
	| BunWorkerHostResponseMessage
	| ShutdownBunWorkerMessage;

interface BunWorkerResponseMessage extends BunWorkerProtocolMessage {
	replyTo?: string;
}

export interface BunWorkerReadyMessage extends BunWorkerResponseMessage {
	type: "ready";
	replyTo: string;
	bunVersion: string;
}

export interface BunWorkerError {
	name: string;
	message: string;
	stack?: string;
}

export interface BunWorkerSuccessResultMessage extends BunWorkerResponseMessage {
	type: "result";
	replyTo: string;
	cellId: string;
	status: "ok";
	durationMs: number;
	stateChanged: boolean;
	value?: string;
	bindingNames: string[];
}

export interface BunWorkerErrorResultMessage extends BunWorkerResponseMessage {
	type: "result";
	replyTo: string;
	cellId: string;
	status: "error";
	durationMs: number;
	stateChanged: boolean;
	error: BunWorkerError;
}

export interface BunWorkerListNamesResultMessage extends BunWorkerResponseMessage {
	type: "list_names_result";
	replyTo: string;
	names: string[];
}

export interface BunWorkerSnapshotResultMessage extends BunWorkerResponseMessage {
	type: "snapshot_result";
	replyTo: string;
	saved: string[];
	skipped: { name: string; reason: string }[];
	bytes: number;
	path: string;
	error?: string;
	persistentMirror?: {
		bytes: number;
		path: string;
		error?: string;
	};
}

export interface BunWorkerRestoreResultMessage extends BunWorkerResponseMessage {
	type: "restore_result";
	replyTo: string;
	restored: string[];
	failed: { name: string; reason: string }[];
	path: string;
	runtimeRestored: boolean;
	error?: string;
}

export interface BunWorkerHostRequestMessage extends BunWorkerResponseMessage {
	type: "host_request";
	requestId: string;
	requestType: string;
	payload: unknown;
	cellId: string;
	cellSource: string;
}

export interface BunWorkerDisplayMessage extends BunWorkerResponseMessage {
	type: "display";
	cellId: string;
	mimeType: string;
	data: unknown;
}

export interface BunWorkerStreamMessage extends BunWorkerResponseMessage {
	type: "stream";
	cellId: string;
	name: "stdout" | "stderr";
	text: string;
}

export interface BunWorkerProtocolErrorMessage extends BunWorkerResponseMessage {
	type: "protocol_error";
	error: BunWorkerError;
}

export interface BunWorkerDiagnosticMessage extends BunWorkerResponseMessage {
	type: "diagnostic";
	cellId?: string;
	error: BunWorkerError;
}

export type BunWorkerToHostMessage =
	| BunWorkerReadyMessage
	| BunWorkerSuccessResultMessage
	| BunWorkerErrorResultMessage
	| BunWorkerListNamesResultMessage
	| BunWorkerSnapshotResultMessage
	| BunWorkerRestoreResultMessage
	| BunWorkerHostRequestMessage
	| BunWorkerStreamMessage
	| BunWorkerDisplayMessage
	| BunWorkerProtocolErrorMessage
	| BunWorkerDiagnosticMessage;
