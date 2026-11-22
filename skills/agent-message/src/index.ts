import { asRecord, emitDisplay, requireString, type SkillContext } from "../../_shared/context.ts";

type ReceiverRole = "parent" | "sibling" | "child";
const MESSAGE_DISPLAY_MIME = "application/vnd.prime-agent.agent-message+json";

interface SendOptions {
	receiverRole: ReceiverRole;
	receiverName?: string;
}

function isReceiverRole(value: unknown): value is ReceiverRole {
	return value === "parent" || value === "sibling" || value === "child";
}

export function createSkill(context: SkillContext) {
	const emitReceipt = (value: unknown, receiverRole?: ReceiverRole): void => {
		const receipt = asRecord(value);
		if (typeof receipt.deliveryStatus !== "string") return;
		const label = receipt.deliveryStatus === "queued" ? "Agent message queued" : "Agent message sent";
		const payload = receiverRole ? { ...receipt, receiverRole } : receipt;
		try {
			emitDisplay(context, MESSAGE_DISPLAY_MIME, payload, label);
		} catch {
			// Best-effort display emission; never fail delivery on display error.
		}
	};

	const sendPayload = async (payload: Record<string, unknown>, receiverRole?: ReceiverRole) => {
		const receipt = await context.hostRequest("agent_message.send", payload);
		const receipts = asRecord(receipt).receipts;
		if (Array.isArray(receipts)) {
			for (const item of receipts) {
				emitReceipt(item);
			}
		} else {
			emitReceipt(receipt, receiverRole);
		}
		return receipt;
	};

	async function send(target: "all", broadcastMessage: string): Promise<unknown>;
	async function send(message: string, options: SendOptions): Promise<unknown>;
	async function send(
		message: string,
		optionsOrBroadcast: SendOptions | string,
	): Promise<unknown> {
		if (typeof optionsOrBroadcast === "string") {
			if (message !== "all") {
				throw new TypeError(
					"positional agentMessage.send targets are not supported; use { receiverRole, receiverName }",
				);
			}
			return sendPayload({ target: "all", message: optionsOrBroadcast });
		}
		requireString(message, "message");
		if (
			typeof optionsOrBroadcast !== "object" ||
			optionsOrBroadcast === null ||
			!isReceiverRole(optionsOrBroadcast.receiverRole)
		) {
			throw new TypeError('receiverRole must be "parent", "sibling", or "child"');
		}
		if (
			optionsOrBroadcast.receiverRole === "parent" &&
			optionsOrBroadcast.receiverName !== undefined
		) {
			throw new TypeError("receiverName must be omitted for parent messages");
		}
		if (
			optionsOrBroadcast.receiverRole !== "parent" &&
			(typeof optionsOrBroadcast.receiverName !== "string" || !optionsOrBroadcast.receiverName.trim())
		) {
			throw new TypeError("receiverName is required for sibling and child messages");
		}
		return sendPayload(
			{
				message,
				receiver_role: optionsOrBroadcast.receiverRole,
				receiver_name: optionsOrBroadcast.receiverName,
			},
			optionsOrBroadcast.receiverRole,
		);
	}

	return {
		send,
		broadcast: async (message: string) => {
			requireString(message, "message");
			return sendPayload({ target: "all", message });
		},
	};
}
