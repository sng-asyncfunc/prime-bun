export const defaultBuiltinToolNames = ["javascript", "write_file", "edit_file"] as const;

export type BuiltinToolName = (typeof defaultBuiltinToolNames)[number];
