import { workflowProfileForKind } from "./plan-rules.ts";
import type {
	CodingStage,
	CodingWorkflowContract,
	WorkflowDataContract,
	WorkflowInputBinding,
	WorkflowTaskPlan,
	WorkflowWorkUnitPlan,
} from "./types.ts";


export interface CodingWorkflowPlan {
	tasks: WorkflowTaskPlan[];
	workUnits: WorkflowWorkUnitPlan[];
}

export const CODING_APPROVAL_ANNOTATION = "pi-agents-flow/coding-approval@1";
export const CODING_PREAPPROVAL_READONLY_ANNOTATION = "pi-agents-flow/coding-preapproval-readonly@1";

export function buildCodingContract(stage: CodingStage): CodingWorkflowContract {
	const completionNodeId = stage === "plan"
		? "coding-plan"
		: stage === "build"
			? "coding-build-verify"
			: "coding-verify";
	return {
		stage,
		completionNodeId,
		completionPort: "result",
		...(stage === "full" ? { approvalGateNodeId: "coding-plan-check" } : {}),
		preApprovalAgents: ["assumptions-analyzer", "planner", "plan-checker"],
	};
}

const MARKDOWN_PORT = {
	mediaType: "text/markdown",
	description: "Complete Markdown artifact produced by this coding stage.",
	storage: "artifact" as const,
	required: true,
	classification: "internal" as const,
};

function input(name: string, nodeId: string, purpose: string): WorkflowInputBinding {
	return {
		name,
		from: [{ nodeId, port: "result" }],
		purpose,
		delivery: "reference",
		merge: "first",
		required: true,
	};
}

function contract(
	kind: WorkflowWorkUnitPlan["kind"],
	inputs: WorkflowInputBinding[] = [],
	options: { approval?: boolean } = {},
): WorkflowDataContract {
	return {
		version: 1,
		profile: workflowProfileForKind(kind),
		inputs,
		outputs: { result: MARKDOWN_PORT },
		context: {
			maxInlineBytes: 16 * 1024,
			maxPackBytes: 96 * 1024,
			maxEstimatedTokens: 18_000,
			clearance: "internal",
		},
		...(options.approval
			? { annotations: { [CODING_APPROVAL_ANNOTATION]: { required: true, gate: "implementation" } } }
			: {}),
	};
}

function spec(
	id: string,
	baseAgent: string,
	role: string,
	objective: string,
	instructions: string,
): WorkflowWorkUnitPlan["agentSpec"] {
	return {
		id: `coding-${id}`,
		baseAgent,
		role,
		objective,
		instructions: [
			instructions,
			"Treat the Workflow goal and authorized input bindings as the task contract.",
			"Read PM/GSD planning files only when they exist and are relevant; their absence must not block an ordinary repository task.",
			"Return the complete stage artifact through the required 'result' output port as a Markdown file submission.",
		].join("\n\n"),
		context: "fork",
	};
}

function unit(input: {
	id: string;
	taskId: string;
	kind: WorkflowWorkUnitPlan["kind"];
	label: string;
	order: number;
	dependsOn?: string[];
	baseAgent: string;
	role: string;
	objective: string;
	instructions: string;
	bindings?: WorkflowInputBinding[];
	approval?: boolean;
}): WorkflowWorkUnitPlan {
	return {
		id: input.id,
		taskId: input.taskId,
		kind: input.kind,
		label: input.label,
		order: input.order,
		dependsOn: input.dependsOn ?? [],
		agentSpec: {
			...spec(input.id, input.baseAgent, input.role, input.objective, input.instructions),
			...(input.baseAgent === "assumptions-analyzer" || input.baseAgent === "planner" || input.baseAgent === "plan-checker"
				? { denyTools: ["bash", "edit", "write"] }
				: {}),
		},
		dataContract: (() => {
			const dataContract = contract(input.kind, input.bindings, { approval: input.approval });
			if (input.baseAgent !== "assumptions-analyzer" && input.baseAgent !== "planner" && input.baseAgent !== "plan-checker") return dataContract;
			return {
				...dataContract,
				annotations: {
					...dataContract.annotations,
					[CODING_PREAPPROVAL_READONLY_ANNOTATION]: { required: true },
				},
			};
		})(),
	};
}

function planningUnits(approval: boolean): WorkflowWorkUnitPlan[] {
	return [
		unit({
			id: "coding-assumptions",
			taskId: "coding-plan",
			kind: "custom",
			label: "Analyze assumptions",
			order: 0,
			baseAgent: "assumptions-analyzer",
			role: "Coding assumptions analyst",
			objective: "Identify evidence-backed assumptions, constraints, unknowns, and decision risks for the coding goal.",
			instructions: "Inspect the repository and produce a concise assumptions report with concrete file evidence. Flag decisions that require user input or external research. Do not modify files.",
		}),
		unit({
			id: "coding-plan",
			taskId: "coding-plan",
			kind: "custom",
			label: "Create implementation plan",
			order: 1,
			dependsOn: ["coding-assumptions"],
			baseAgent: "planner",
			role: "Coding planner",
			objective: "Produce a bounded executable implementation plan for the coding goal.",
			instructions: "Use the authorized assumptions input and repository evidence. Specify scope, exact files or ownership boundaries, implementation steps, verification commands, and residual risks. Do not implement the plan.",
			bindings: [input("assumptions", "coding-assumptions", "Evidence-backed assumptions and constraints for planning.")],
		}),
		unit({
			id: "coding-plan-check",
			taskId: "coding-plan",
			kind: "verification",
			label: "Verify implementation plan",
			order: 2,
			dependsOn: ["coding-plan"],
			baseAgent: "plan-checker",
			role: "Coding plan verifier",
			objective: "Verify that the implementation plan can achieve the coding goal without hidden gaps.",
			instructions: "Review the authorized plan against the Workflow goal and repository constraints. Return PASS or actionable blockers. Do not inspect implementation results or modify files.",
			bindings: [input("plan", "coding-plan", "Implementation plan to verify before execution.")],
			approval,
		}),
	];
}

function buildUnits(full: boolean): WorkflowWorkUnitPlan[] {
	const dependencies = full ? ["coding-plan", "coding-plan-check"] : [];
	const bindings = full
		? [
			input("plan", "coding-plan", "Approved implementation plan to execute."),
			input("plan_review", "coding-plan-check", "Accepted plan verification and constraints."),
		]
		: [];
	return [
		unit({
			id: "coding-build",
			taskId: "coding-build",
			kind: "custom",
			label: "Implement approved change",
			order: 0,
			dependsOn: dependencies,
			baseAgent: "executor",
			role: "Coding implementation worker",
			objective: "Implement the approved coding goal end to end and produce verification evidence.",
			instructions: full
				? "Implement only the authorized plan. Run focused tests and required repository checks. Report changed files, command results, deviations, and residual risks."
				: "Treat the Workflow goal as an already approved implementation request. Inspect the repository, implement the smallest complete change, run focused tests and required checks, and report changed files, command results, deviations, and residual risks.",
			bindings,
		}),
	];
}

function reviewUnit(taskId: string, buildDependency: boolean, order: number): WorkflowWorkUnitPlan {
	return unit({
		id: "coding-review",
		taskId,
		kind: "reviewer",
		label: "Review code quality",
		order,
		dependsOn: buildDependency ? ["coding-build"] : [],
		baseAgent: "reviewer",
		role: "Coding code reviewer",
		objective: "Find correctness, regression, maintainability, and test-coverage problems relevant to the coding goal.",
		instructions: "Review repository truth and the authorized implementation report when present. Lead with concrete findings ordered by severity and cite files. Distinguish blockers from optional improvements. Do not modify files.",
		bindings: buildDependency
			? [input("implementation", "coding-build", "Implementation report and verification evidence to review.")]
			: [],
	});
}

function buildVerificationUnit(): WorkflowWorkUnitPlan {
	return unit({
		id: "coding-build-verify",
		taskId: "coding-build",
		kind: "verification",
		label: "Verify implemented goal",
		order: 2,
		dependsOn: ["coding-build", "coding-review"],
		baseAgent: "verifier",
		role: "Coding implementation verifier",
		objective: "Determine whether repository evidence proves that the implemented coding goal is fully delivered.",
		instructions: "Perform goal-backward verification using repository truth, the authorized implementation report, and the accepted code review. Run focused read-only checks. Report passed requirements, gaps, human-verification needs, and residual risks. Do not modify production files.",
		bindings: [
			input("implementation", "coding-build", "Implementation report and verification evidence to validate."),
			input("code_review", "coding-review", "Accepted correctness and regression review findings."),
		],
	});
}

function verificationUnits(buildDependency: boolean): WorkflowWorkUnitPlan[] {
	const integrationDependsOn = buildDependency ? ["coding-build"] : [];
	const integrationBindings = buildDependency
		? [input("implementation", "coding-build", "Implementation report and verification evidence to inspect.")]
		: [];
	const verifierDependsOn = buildDependency
		? ["coding-build", "coding-review", "coding-integration"]
		: ["coding-review", "coding-integration"];
	const verifierBindings = [
		...(buildDependency
			? [input("implementation", "coding-build", "Implementation report to verify against repository truth.")]
			: []),
		input("code_review", "coding-review", "Accepted correctness and regression review findings."),
		input("integration", "coding-integration", "Cross-module and end-to-end integration findings."),
	];
	return [
		reviewUnit("coding-verify", buildDependency, 0),
		unit({
			id: "coding-integration",
			taskId: "coding-verify",
			kind: "verification",
			label: "Check integration",
			order: 1,
			dependsOn: integrationDependsOn,
			baseAgent: "integration-checker",
			role: "Coding integration verifier",
			objective: "Verify cross-module wiring, data flow, and end-to-end behavior for the coding goal.",
			instructions: "Inspect repository truth and the authorized implementation input when present. Trace real connections and identify precise breaks. Do not modify files.",
			bindings: integrationBindings,
		}),
		unit({
			id: "coding-verify",
			taskId: "coding-verify",
			kind: "verification",
			label: "Verify goal delivery",
			order: 2,
			dependsOn: verifierDependsOn,
			baseAgent: "verifier",
			role: "Coding goal verifier",
			objective: "Determine whether repository evidence proves that the coding goal is fully delivered.",
			instructions: "Perform goal-backward verification using repository truth and authorized code-review and integration inputs. Run focused read-only checks. Report passed requirements, gaps, human-verification needs, and residual risks. Do not modify production files.",
			bindings: verifierBindings,
		}),
	];
}

export function buildCodingWorkflowPlan(stage: CodingStage): CodingWorkflowPlan {
	const tasks: WorkflowTaskPlan[] = [];
	const workUnits: WorkflowWorkUnitPlan[] = [];
	if (stage === "plan" || stage === "full") {
		tasks.push({ id: "coding-plan", label: "Plan the coding change", order: 0 });
		workUnits.push(...planningUnits(stage === "full"));
	}
	if (stage === "build" || stage === "full") {
		tasks.push({ id: "coding-build", label: "Implement the coding change", order: tasks.length });
		workUnits.push(...buildUnits(stage === "full"));
		if (stage === "build") workUnits.push(reviewUnit("coding-build", true, 1), buildVerificationUnit());
	}
	if (stage === "verify" || stage === "full") {
		tasks.push({ id: "coding-verify", label: "Verify the coding result", order: tasks.length });
		workUnits.push(...verificationUnits(stage === "full"));
	}
	const completionNodeId = stage === "plan"
		? "coding-plan"
		: stage === "build"
			? "coding-build-verify"
			: "coding-verify";
	const workflowContract: CodingWorkflowContract = {
		stage,
		completionNodeId,
		completionPort: "result",
		...(stage === "full" ? { approvalGateNodeId: "coding-plan-check" } : {}),
		preApprovalAgents: ["assumptions-analyzer", "planner", "plan-checker"],
	};
	const contractCarrier = workUnits[0];
	if (!contractCarrier) throw new Error(`Coding stage '${stage}' produced no work units.`);
	return { tasks, workUnits };
}
