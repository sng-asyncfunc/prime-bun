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
import { createJavaScriptTool, createJavaScriptToolDefinition, type JavaScriptToolOptions } from "./javascript.js";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName = "javascript";
export const allToolNames: Set<ToolName> = new Set(["javascript"]);

export interface ToolsOptions {
	javascript?: JavaScriptToolOptions;
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "javascript":
			return createJavaScriptToolDefinition(cwd, options?.javascript);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "javascript":
			return createJavaScriptTool(cwd, options?.javascript);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		javascript: createJavaScriptToolDefinition(cwd, options?.javascript),
	};
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		javascript: createJavaScriptTool(cwd, options?.javascript),
	};
}
