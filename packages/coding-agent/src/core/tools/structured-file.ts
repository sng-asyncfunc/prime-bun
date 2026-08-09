import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.js";
import {
	createJavaScriptToolDefinition,
	type JavaScriptToolDetails,
	type JavaScriptToolOptions,
} from "./javascript.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const writeFileSchema = Type.Object(
	{
		path: Type.String({ description: "File path to create or replace." }),
		content: Type.String({
			description: "Exact UTF-8 content, carried outside JavaScript syntax. May be empty.",
		}),
	},
	{ additionalProperties: false },
);

const editFileSchema = Type.Object(
	{
		path: Type.String({ description: "Existing file path to edit." }),
		oldStr: Type.String({ description: "Exact unique text to replace; include enough context." }),
		newStr: Type.String({ description: "Exact replacement text, carried outside JavaScript syntax. May be empty." }),
	},
	{ additionalProperties: false },
);

export type WriteFileToolInput = Static<typeof writeFileSchema>;
export type EditFileToolInput = Static<typeof editFileSchema>;

export function createWriteFileToolDefinition(
	cwd: string,
	options?: JavaScriptToolOptions,
): ToolDefinition<typeof writeFileSchema, JavaScriptToolDetails> {
	const javascript = createJavaScriptToolDefinition(cwd, options);
	return {
		name: "write_file",
		label: "Write file",
		description:
			"Create or replace an exact UTF-8 file. The content travels as a JSON argument outside JavaScript syntax, so quotes, Markdown fences, backticks, interpolation text, and Unicode remain exact. Missing parent directories are created automatically. Use this for authored documents; use JavaScript filesystem APIs only for values produced by computation. Structured writes are limited to 1,000,000 characters.",
		promptSnippet: "write_file - create or replace exact authored content without JavaScript string syntax",
		executionMode: "sequential",
		parameters: writeFileSchema,
		execute: (toolCallId, params, signal, onUpdate, ctx) =>
			javascript.execute(
				toolCallId,
				{ actions: [{ op: "write", path: params.path, content: params.content }] },
				signal,
				onUpdate,
				ctx,
			),
	};
}

export function createEditFileToolDefinition(
	cwd: string,
	options?: JavaScriptToolOptions,
): ToolDefinition<typeof editFileSchema, JavaScriptToolDetails> {
	const javascript = createJavaScriptToolDefinition(cwd, options);
	return {
		name: "edit_file",
		label: "Edit file",
		description:
			"Replace one exact, unique string in an existing file. The old and new text travel as JSON arguments outside JavaScript syntax, so quotes, Markdown fences, backticks, interpolation text, and Unicode remain exact. Include enough unchanged context to make the match unique; newStr may be empty.",
		promptSnippet: "edit_file - replace one exact unique string without JavaScript string syntax",
		executionMode: "sequential",
		parameters: editFileSchema,
		execute: (toolCallId, params, signal, onUpdate, ctx) =>
			javascript.execute(
				toolCallId,
				{ actions: [{ op: "edit", path: params.path, oldStr: params.oldStr, newStr: params.newStr }] },
				signal,
				onUpdate,
				ctx,
			),
	};
}

export function createWriteFileTool(cwd: string, options?: JavaScriptToolOptions): AgentTool<typeof writeFileSchema> {
	return wrapToolDefinition(createWriteFileToolDefinition(cwd, options));
}

export function createEditFileTool(cwd: string, options?: JavaScriptToolOptions): AgentTool<typeof editFileSchema> {
	return wrapToolDefinition(createEditFileToolDefinition(cwd, options));
}
