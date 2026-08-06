import { requireInteger, requireString, type SkillContext } from "../../_shared/context.ts";

interface GoalCreateOptions {
	tokenBudget?: number;
}

export function createSkill(context: SkillContext) {
	return {
		get: () => context.hostRequest("goal.get"),
		create: (objective: string, options: GoalCreateOptions = {}) => {
			requireString(objective, "objective");
			if (options.tokenBudget !== undefined) requireInteger(options.tokenBudget, "tokenBudget");
			return context.hostRequest("goal.create", {
				objective,
				...(options.tokenBudget === undefined ? {} : { token_budget: options.tokenBudget }),
			});
		},
		complete: () => context.hostRequest("goal.complete"),
	};
}
