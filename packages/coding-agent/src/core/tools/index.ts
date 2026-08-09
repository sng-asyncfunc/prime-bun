export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.js";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.js";
export { withFileMutationQueue } from "./file-mutation-queue.js";
export {
	BunKernelProvisioner,
	createJavaScriptTool,
	createJavaScriptToolDefinition,
	imageBlocksFromAttachments,
	type JavaScriptToolDetails,
	type JavaScriptToolInput,
	type JavaScriptToolOptions,
} from "./javascript.js";
export {
	createEditFileTool,
	createEditFileToolDefinition,
	createWriteFileTool,
	createWriteFileToolDefinition,
	type EditFileToolInput,
	type WriteFileToolInput,
} from "./structured-file.js";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.js";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.js";
import {
	BunKernelProvisioner,
	createJavaScriptTool,
	createJavaScriptToolDefinition,
	type JavaScriptToolOptions,
} from "./javascript.js";
import {
	createEditFileTool,
	createEditFileToolDefinition,
	createWriteFileTool,
	createWriteFileToolDefinition,
} from "./structured-file.js";
import { type BuiltinToolName, defaultBuiltinToolNames } from "./tool-names.js";

export { type BuiltinToolName, defaultBuiltinToolNames } from "./tool-names.js";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName = BuiltinToolName;
export const allToolNames: Set<ToolName> = new Set(defaultBuiltinToolNames);

export interface ToolsOptions {
	javascript?: JavaScriptToolOptions;
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "javascript":
			return createJavaScriptToolDefinition(cwd, options?.javascript);
		case "write_file":
			return createWriteFileToolDefinition(cwd, options?.javascript);
		case "edit_file":
			return createEditFileToolDefinition(cwd, options?.javascript);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "javascript":
			return createJavaScriptTool(cwd, options?.javascript);
		case "write_file":
			return createWriteFileTool(cwd, options?.javascript);
		case "edit_file":
			return createEditFileTool(cwd, options?.javascript);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

function sharedJavaScriptOptions(cwd: string, options?: ToolsOptions): JavaScriptToolOptions {
	const javascript = options?.javascript;
	if (javascript?.provisioner) return javascript;
	return { ...javascript, provisioner: new BunKernelProvisioner(cwd, javascript) };
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	const javascript = sharedJavaScriptOptions(cwd, options);
	return {
		javascript: createJavaScriptToolDefinition(cwd, javascript),
		write_file: createWriteFileToolDefinition(cwd, javascript),
		edit_file: createEditFileToolDefinition(cwd, javascript),
	};
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	const javascript = sharedJavaScriptOptions(cwd, options);
	return {
		javascript: createJavaScriptTool(cwd, javascript),
		write_file: createWriteFileTool(cwd, javascript),
		edit_file: createEditFileTool(cwd, javascript),
	};
}
