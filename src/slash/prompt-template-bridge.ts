import {
	SUBAGENT_DELEGATION_CANCEL_EVENT,
	SUBAGENT_DELEGATION_PROTOCOL_VERSION,
	SUBAGENT_DELEGATION_REQUEST_EVENT,
	SUBAGENT_DELEGATION_RESPONSE_EVENT,
	SUBAGENT_DELEGATION_STARTED_EVENT,
	SUBAGENT_DELEGATION_UPDATE_EVENT,
	type SubagentDelegationInvalidResponse,
	type SubagentDelegationRequest,
	type SubagentDelegationResponse,
} from "../api/delegation.ts";
import {
	parsePromptTemplateRequest,
	toDelegationUpdate,
	toLegacyExecutionParams,
	toPromptTemplateResponse,
	toSubagentDelegationExecutionParams,
	toSubagentDelegationResponse,
	toSubagentDelegationUpdate,
	type DelegatedSubagentExecutionParams,
	type PromptTemplateBridgeResult,
	type PromptTemplateDelegationRequest,
	type PromptTemplateDelegationResponse,
} from "./delegation-adapters.ts";
import { parseSubagentDelegationRequest } from "./delegation-request.ts";

export const PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT = SUBAGENT_DELEGATION_REQUEST_EVENT;
export const PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT = SUBAGENT_DELEGATION_STARTED_EVENT;
export const PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT = SUBAGENT_DELEGATION_RESPONSE_EVENT;
export const PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT = SUBAGENT_DELEGATION_UPDATE_EVENT;
export const PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT = SUBAGENT_DELEGATION_CANCEL_EVENT;

export interface PromptTemplateBridgeEvents {
	on(event: string, handler: (data: unknown) => void): (() => void) | void;
	emit(event: string, data: unknown): void;
}

interface PromptTemplateBridgeOptions<Ctx extends { cwd?: string }> {
	events: PromptTemplateBridgeEvents;
	getContext: () => Ctx | null;
	execute: (
		requestId: string,
		params: DelegatedSubagentExecutionParams,
		signal: AbortSignal,
		ctx: Ctx,
		onUpdate: (result: PromptTemplateBridgeResult) => void,
		origin: "model" | "user",
	) => Promise<PromptTemplateBridgeResult>;
	/** Concurrent-safe executor for strict delegation requests. */
	executeVersioned?: (
		requestId: string,
		params: DelegatedSubagentExecutionParams,
		signal: AbortSignal,
		ctx: Ctx,
		onUpdate: (result: PromptTemplateBridgeResult) => void,
		origin: "model" | "user",
	) => Promise<PromptTemplateBridgeResult>;
}

function validIdentity(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\r\n]/.test(value);
}

export function registerPromptTemplateDelegationBridge<Ctx extends { cwd?: string }>(
	options: PromptTemplateBridgeOptions<Ctx>,
): { cancelAll: () => void; dispose: () => void } {
	const legacyControllers = new Map<string, AbortController>();
	const legacyPendingCancels = new Map<string, true>();
	const attemptControllers = new Map<string, AbortController>();
	const pendingAttemptCancels = new Map<string, true>();
	const activeNodes = new Map<string, { attemptKey: string; controller: AbortController }>();
	const settledAttempts = new Map<string, true>();
	const subscriptions: Array<() => void> = [];
	let disposed = false;
	let identitySaturated = false;

	const subscribe = (event: string, handler: (data: unknown) => void): void => {
		const unsubscribe = options.events.on(event, handler);
		if (typeof unsubscribe === "function") subscriptions.push(unsubscribe);
	};
	const ownsLegacyRequest = (requestId: string, controller: AbortController): boolean =>
		!disposed && legacyControllers.get(requestId) === controller;
	const ownsAttempt = (attemptKey: string, controller: AbortController): boolean =>
		!disposed && attemptControllers.get(attemptKey) === controller;
	const boundedRemember = (map: Map<string, true>, key: string): void => {
		map.delete(key);
		map.set(key, true);
		while (map.size > 256) {
			const oldest = map.keys().next().value;
			if (typeof oldest !== "string") break;
			map.delete(oldest);
		}
	};
	const rememberIdentity = (map: Map<string, true>, key: string): void => {
		if (map.has(key) || identitySaturated) return;
		if (map.size >= 8_192) {
			identitySaturated = true;
			return;
		}
		map.set(key, true);
		if (map.size === 8_192) identitySaturated = true;
	};
	const nodeKey = (ownerRunId: string, nodeId: string): string => JSON.stringify([ownerRunId, nodeId]);
	const attemptKey = (requestId: string, ownerRunId: string, nodeId: string): string =>
		JSON.stringify([requestId, ownerRunId, nodeId]);
	const emitTerminal = (key: string, payload: SubagentDelegationResponse): void => {
		if (disposed || settledAttempts.has(key)) return;
		rememberIdentity(settledAttempts, key);
		options.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, payload);
	};

	subscribe(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, (data) => {
		if (!data || typeof data !== "object" || Array.isArray(data)) return;
		const value = data as Record<string, unknown>;
		if (!validIdentity(value.requestId)) return;
		if (Object.hasOwn(value, "version")) {
			if (value.version !== SUBAGENT_DELEGATION_PROTOCOL_VERSION) return;
			if (Object.keys(value).some((key) => key !== "version" && key !== "requestId" && key !== "ownerRunId" && key !== "nodeId")) return;
			if (!validIdentity(value.ownerRunId) || !validIdentity(value.nodeId)) return;
			const key = attemptKey(value.requestId, value.ownerRunId, value.nodeId);
			const controller = attemptControllers.get(key);
			if (controller) controller.abort();
			else rememberIdentity(pendingAttemptCancels, key);
			return;
		}
		const controller = legacyControllers.get(value.requestId);
		if (controller) controller.abort();
		else boundedRemember(legacyPendingCancels, value.requestId);
	});

	subscribe(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, async (data) => {
		const isProtocolRequest = !!data && typeof data === "object" && Object.hasOwn(data, "version");
		let request: SubagentDelegationRequest | undefined;
		let legacyRequest: PromptTemplateDelegationRequest | undefined;
		let requestId: string;
		let params: DelegatedSubagentExecutionParams;
		let key: string | undefined;

		if (isProtocolRequest) {
			const parsed = parseSubagentDelegationRequest(data);
			if (!parsed.ok) {
				if (!disposed && parsed.requestId) {
					const payload = {
						version: SUBAGENT_DELEGATION_PROTOCOL_VERSION,
						requestId: parsed.requestId,
						...(parsed.ownerRunId ? { ownerRunId: parsed.ownerRunId } : {}),
						...(parsed.nodeId ? { nodeId: parsed.nodeId } : {}),
						status: "invalid_request",
						error: parsed.error,
					} satisfies SubagentDelegationInvalidResponse;
					if (parsed.ownerRunId && parsed.nodeId) {
						const invalidKey = attemptKey(parsed.requestId, parsed.ownerRunId, parsed.nodeId);
						if (!attemptControllers.has(invalidKey)) emitTerminal(invalidKey, payload);
					} else {
						options.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, payload);
					}
				}
				return;
			}
			request = parsed.request;
			requestId = request.requestId;
			key = attemptKey(requestId, request.ownerRunId, request.nodeId);
			params = toSubagentDelegationExecutionParams(request);
		} else {
			legacyRequest = parsePromptTemplateRequest(data);
			if (!legacyRequest) return;
			requestId = legacyRequest.requestId;
			params = toLegacyExecutionParams(legacyRequest);
		}

		if (request && key) {
			if (attemptControllers.has(key) || settledAttempts.has(key)) return;
			if (pendingAttemptCancels.delete(key)) {
				emitTerminal(key, { version: SUBAGENT_DELEGATION_PROTOCOL_VERSION, requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId, status: "cancelled" });
				return;
			}
			if (identitySaturated) {
				options.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
					version: SUBAGENT_DELEGATION_PROTOCOL_VERSION,
					requestId,
					ownerRunId: request.ownerRunId,
					nodeId: request.nodeId,
					status: "unavailable_context",
					error: "Delegation identity capacity is exhausted for this extension context.",
				} satisfies SubagentDelegationResponse);
				return;
			}
			if (activeNodes.has(nodeKey(request.ownerRunId, request.nodeId))) {
				emitTerminal(key, { version: SUBAGENT_DELEGATION_PROTOCOL_VERSION, requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId, status: "duplicate_node" });
				return;
			}
		} else if (legacyControllers.has(requestId)) {
			return;
		}

		const ctx = options.getContext();
		if (!ctx) {
			if (request && key) {
				emitTerminal(key, {
					version: SUBAGENT_DELEGATION_PROTOCOL_VERSION,
					requestId,
					ownerRunId: request.ownerRunId,
					nodeId: request.nodeId,
					status: "unavailable_context",
					error: "No active extension context for delegated subagent execution.",
				});
			} else if (legacyRequest) {
				options.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					...legacyRequest,
					messages: [],
					isError: true,
					errorText: "No active extension context for delegated subagent execution.",
				} satisfies PromptTemplateDelegationResponse);
			}
			return;
		}

		const controller = new AbortController();
		if (request && key) {
			attemptControllers.set(key, controller);
			activeNodes.set(nodeKey(request.ownerRunId, request.nodeId), { attemptKey: key, controller });
		} else {
			legacyControllers.set(requestId, controller);
			if (legacyPendingCancels.delete(requestId)) controller.abort();
		}
		if (controller.signal.aborted) {
			if (request && key) {
				emitTerminal(key, { version: SUBAGENT_DELEGATION_PROTOCOL_VERSION, requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId, status: "cancelled" });
				activeNodes.delete(nodeKey(request.ownerRunId, request.nodeId));
				attemptControllers.delete(key);
			} else if (legacyRequest) {
				options.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					...legacyRequest,
					messages: [],
					isError: true,
					errorText: "Delegated prompt cancelled.",
				} satisfies PromptTemplateDelegationResponse);
				legacyControllers.delete(requestId);
			}
			return;
		}

		options.events.emit(
			request ? SUBAGENT_DELEGATION_STARTED_EVENT : PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT,
			request
				? { version: SUBAGENT_DELEGATION_PROTOCOL_VERSION, requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId }
				: { requestId },
		);

		try {
			const executeRequest = request && options.executeVersioned ? options.executeVersioned : options.execute;
			const result = await executeRequest(
				requestId,
				params,
				controller.signal,
				ctx,
				(update) => {
					if (key ? !ownsAttempt(key, controller) : !ownsLegacyRequest(requestId, controller)) return;
					const payload = request
						? toSubagentDelegationUpdate(request, update)
						: toDelegationUpdate(requestId, update);
					if (payload) options.events.emit(request ? SUBAGENT_DELEGATION_UPDATE_EVENT : PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT, payload);
				},
				request ? "model" : "user",
			);
			if (key ? !ownsAttempt(key, controller) : !ownsLegacyRequest(requestId, controller)) return;
			if (request && key) {
				emitTerminal(key, toSubagentDelegationResponse(request, result, controller.signal.aborted));
			} else if (legacyRequest) {
				options.events.emit(
					PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT,
					controller.signal.aborted
						? { ...legacyRequest, messages: [], isError: true, errorText: "Delegated prompt cancelled." }
						: toPromptTemplateResponse(legacyRequest, result),
				);
			}
		} catch (error) {
			if (key ? !ownsAttempt(key, controller) : !ownsLegacyRequest(requestId, controller)) return;
			if (request && key) {
				emitTerminal(key, {
					version: SUBAGENT_DELEGATION_PROTOCOL_VERSION,
					requestId,
					ownerRunId: request.ownerRunId,
					nodeId: request.nodeId,
					status: controller.signal.aborted ? "cancelled" : "failed",
					...(controller.signal.aborted ? {} : { error: error instanceof Error ? error.message : String(error) }),
				});
			} else if (legacyRequest) {
				options.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					...legacyRequest,
					messages: [],
					isError: true,
					errorText: error instanceof Error ? error.message : String(error),
				} satisfies PromptTemplateDelegationResponse);
			}
		} finally {
			if (key) {
				if (attemptControllers.get(key) === controller) attemptControllers.delete(key);
			} else if (legacyControllers.get(requestId) === controller) {
				legacyControllers.delete(requestId);
			}
			if (request) {
				const logicalKey = nodeKey(request.ownerRunId, request.nodeId);
				if (activeNodes.get(logicalKey)?.controller === controller) activeNodes.delete(logicalKey);
			}
		}
	});

	return {
		cancelAll: () => {
			for (const controller of legacyControllers.values()) controller.abort();
			for (const controller of attemptControllers.values()) controller.abort();
			legacyControllers.clear();
			attemptControllers.clear();
			legacyPendingCancels.clear();
			pendingAttemptCancels.clear();
			activeNodes.clear();
			settledAttempts.clear();
			identitySaturated = false;
		},
		dispose: () => {
			disposed = true;
			for (const controller of legacyControllers.values()) controller.abort();
			for (const controller of attemptControllers.values()) controller.abort();
			legacyControllers.clear();
			attemptControllers.clear();
			for (const unsubscribe of subscriptions) unsubscribe();
			subscriptions.length = 0;
			legacyPendingCancels.clear();
			pendingAttemptCancels.clear();
			activeNodes.clear();
			settledAttempts.clear();
		},
	};
}
