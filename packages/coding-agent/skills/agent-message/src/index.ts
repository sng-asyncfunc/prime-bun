import { asRecord, requireString, type SkillContext } from "../../_shared/context.ts";

type ReceiverRole = "parent" | "sibling" | "child";
const MESSAGE_DISPLAY_MIME = "application/vnd.prime-agent.agent-message+json";

interface SendOptions {
	receiverRole: ReceiverRole;
	receiverName?: string;
}

function isReceiverRole(value: string): value is ReceiverRole {
	return value === "parent" || value === "sibling" || value === "child";
}

export function createSkill(context: SkillContext) {
	const emitReceipt = (value: unknown, receiverRole?: ReceiverRole): void => {
		const receipt = asRecord(value);
		if (Object.keys(receipt).length === 0) return;
		context.display(MESSAGE_DISPLAY_MIME, receiverRole ? { ...receipt, receiverRole } : receipt);
	};

	const sendPayload = async (payload: Record<string, unknown>, receiverRole?: ReceiverRole) => {
		const receipt = await context.hostRequest("agent_message.send", payload);
		const receipts = asRecord(receipt).receipts;
		if (Array.isArray(receipts)) {
			for (const item of receipts) emitReceipt(item);
		} else {
			emitReceipt(receipt, receiverRole);
		}
		return receipt;
	};

	return {
		listAgents: () => context.hostRequest("agent_message.list_agents"),
		send: async (message: string, options: SendOptions) => {
			requireString(message, "message");
			if (!options || !isReceiverRole(options.receiverRole)) {
				throw new TypeError('receiverRole must be "parent", "sibling", or "child"');
			}
			if (options.receiverRole === "parent" && options.receiverName !== undefined) {
				throw new TypeError("receiverName must be omitted for parent messages");
			}
			if (
				options.receiverRole !== "parent" &&
				(typeof options.receiverName !== "string" || !options.receiverName.trim())
			) {
				throw new TypeError("receiverName is required for sibling and child messages");
			}
			return sendPayload(
				{
					message,
					receiver_role: options.receiverRole,
					receiver_name: options.receiverName,
				},
				options.receiverRole,
			);
		},
		broadcast: async (message: string) => {
			requireString(message, "message");
			return sendPayload({ target: "all", message });
		},
	};
}
