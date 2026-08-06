import { requireInteger, requireString, type SkillContext } from "../../_shared/context.ts";

interface RecentMessageOptions {
	limit?: number;
	maxChars?: number;
}

export function createSkill(context: SkillContext) {
	return {
		listAgents: () => context.hostRequest("agent_observe.list"),
		getAgent: (target: string) => {
			requireString(target, "target");
			return context.hostRequest("agent_observe.get", { target });
		},
		recentMessages: (target: string, options: RecentMessageOptions = {}) => {
			requireString(target, "target");
			const limit = options.limit ?? 8;
			const maxChars = options.maxChars ?? 800;
			requireInteger(limit, "limit");
			requireInteger(maxChars, "maxChars");
			return context.hostRequest("agent_observe.recent", {
				target,
				limit,
				max_chars: maxChars,
			});
		},
	};
}
