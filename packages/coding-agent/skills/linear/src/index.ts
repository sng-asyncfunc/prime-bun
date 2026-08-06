import { createMcpIntegration } from "../../_shared/mcp.ts";
import { type SkillContext } from "../../_shared/context.ts";

export function createSkill(context: SkillContext) {
	return createMcpIntegration(context, {
		server: "linear",
		url: "https://mcp.linear.app/mcp",
	});
}
