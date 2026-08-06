export const BUN_WORKER_PROTOCOL_VERSION = 1;

interface BunWorkerProtocolMessage {
	id: string;
	protocolVersion: typeof BUN_WORKER_PROTOCOL_VERSION;
	type: string;
}

export interface InitializeBunWorkerMessage extends BunWorkerProtocolMessage {
	type: "initialize";
	cwd: string;
	shellPath: string;
	commandPrefix: string;
}

export interface ExecuteBunCellMessage extends BunWorkerProtocolMessage {
	type: "execute";
	cellId: string;
	code: string;
}

export interface ListBunWorkerNamesMessage extends BunWorkerProtocolMessage {
	type: "list_names";
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
	value?: string;
	bindingNames: string[];
}

export interface BunWorkerErrorResultMessage extends BunWorkerResponseMessage {
	type: "result";
	replyTo: string;
	cellId: string;
	status: "error";
	durationMs: number;
	error: BunWorkerError;
}

export interface BunWorkerListNamesResultMessage extends BunWorkerResponseMessage {
	type: "list_names_result";
	replyTo: string;
	names: string[];
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
	| BunWorkerHostRequestMessage
	| BunWorkerDisplayMessage
	| BunWorkerProtocolErrorMessage
	| BunWorkerDiagnosticMessage;
