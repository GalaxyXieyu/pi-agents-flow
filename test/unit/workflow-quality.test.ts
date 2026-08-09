import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assessWorkflowQuality, formatWorkflowQualityReport } from "../../src/workflows/quality.ts";
import type { WorkflowResult, WorkflowFinding, WorkflowNode, WorkflowRun } from "../../src/workflows/types.ts";

function finding(claim: string, options: {
	confidence?: WorkflowFinding["confidence"];
	kind?: NonNullable<WorkflowFinding["evidence"][number]["kind"]>;
	quote?: string;
	url?: string;
	artifactPath?: string;
} = {}): WorkflowFinding {
	return {
		claim,
		confidence: options.confidence ?? "high",
		evidence: [{
			...(options.url === undefined && options.artifactPath === undefined ? { url: `https://example.test/${claim}` } : {}),
			...(options.url ? { url: options.url } : {}),
			...(options.artifactPath ? { artifactPath: options.artifactPath } : {}),
			...(options.kind ? { kind: options.kind } : {}),
			...(options.quote ? { quote: options.quote } : {}),
		}],
	};
}

function envelope(findings: WorkflowFinding[], options: {
	gaps?: WorkflowResult["diagnostics"]["gaps"];
	conflicts?: WorkflowResult["diagnostics"]["conflicts"];
	queries?: string[];
	fetchedUrls?: string[];
} = {}): WorkflowResult {
	return {
		version: 1,
		summary: { text: "accepted result", covers: [], omissions: [], confidence: "high" },
		outputs: { result: { kind: "value", value: "accepted result" } },
		diagnostics: { gaps: options.gaps ?? [], conflicts: options.conflicts ?? [], warnings: [] },
		recommendations: [],
		evidence: {
			findings,
			...(options.queries || options.fetchedUrls ? {
				search: { queries: options.queries ?? [], fetchedUrls: options.fetchedUrls ?? [], droppedSources: [] },
			} : {}),
		},
	};
}

function documentEnvelope(markdown: string): WorkflowResult {
	return { version: 1, summary: { text: markdown.slice(0, 100), covers: ["document"], omissions: [], confidence: "high" }, outputs: { document: { kind: "value", value: markdown } }, diagnostics: { gaps: [], conflicts: [], warnings: [] }, recommendations: [], evidence: { findings: [] } };
}

function acceptedNode(id: string, kind: WorkflowNode["kind"], result: WorkflowResult, dependsOn: string[] = []): WorkflowNode {
	const baseAgent = kind === "section-writer"
		? "research-section-writer"
		: kind === "editor"
			? "research-editor"
			: kind === "writer"
				? "research-writer"
				: kind === "reviewer"
					? "research-reviewer"
					: "researcher";
	return {
		id,
		kind,
		label: id,
		dependsOn,
		status: "accepted",
		attempts: [{
			attemptId: `${id}:1`,
			requestId: `request-${id}`,
			number: 1,
			startedAt: 1,
			completedAt: 2,
			status: "completed",
			result,
			childRunId: `child-${id}`,
			launchContractDigest: `digest-${id}`,
			model: "test/model",
		}],
		result,
		decision: "accepted",
		agentSpec: {
			id: `agent-${id}`,
			baseAgent,
			role: kind,
			objective: id,
			instructions: id,
			context: "fresh",
		},
		dataContract: { version: 1, profile: "research", inputs: [], outputs: { result: { mediaType: "application/json", description: "result", storage: "artifact", required: true, classification: "internal" } } },
	};
}

function run(nodes: WorkflowNode[], decisions: WorkflowRun["decisions"] = []): WorkflowRun {
	return {
		version: 0,
		id: "workflow-quality",
		mode: "deep-research",
		goal: "Research",
		cwd: "/repo",
		sessionId: "session-1",
		branch: "main",
		status: "active",
		revision: 10,
		createdAt: 1,
		updatedAt: 10,
		researchBrief: {
			version: 0,
			audience: "Senior engineers",
			purpose: "Support an implementation decision",
			scope: "Architecture and operations",
			depth: "deep",
			deliverable: "research-report",
			targetWords: { min: 120, max: 600 },
			requiredTopics: ["Background", "Technical Details"],
			excludedTopics: [],
			constraints: [],
			assumptions: [],
			clarification: "confirmed",
		},
		documentOutline: {
			version: 0,
			title: "Research report",
			thesis: "Evidence supports the implementation decision.",
			approval: "user",
			sections: [
				{ id: "background", title: "Background", objective: "Explain context", questions: ["Why?"], evidenceRequirements: ["Primary source"], targetWords: 100, writerNodeId: "section-a" },
				{ id: "technical", title: "Technical Details", objective: "Explain mechanism", questions: ["How?"], evidenceRequirements: ["Implementation evidence"], targetWords: 100, writerNodeId: "section-b" },
			],
		},
		nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
		decisions,
		appliedEventIds: ["started"],
	};
}

function validResearchNode(id: string): WorkflowNode {
	const url = `https://official.test/${id}`;
	return acceptedNode(id, "research", envelope([
		finding(`${id} claim`, { url, kind: "primary", quote: `${id} direct quote` }),
	], { queries: [`${id} query`], fetchedUrls: [url] }));
}

function documentNodes(researchNodes: WorkflowNode[]): WorkflowNode[] {
	const findings = researchNodes.flatMap((node) => node.result?.evidence?.findings ?? []);
	const references = findings.flatMap((entry) => entry.evidence.map((evidence) => evidence.url ?? evidence.artifactPath).filter((reference): reference is string => Boolean(reference)));
	const first = references[0] ?? "missing-evidence";
	const second = references[1] ?? first;
		const background = `## Background\n\n${"This section explains the decision context, constraints, stakeholders, prior approaches, and verified background in enough detail for an engineering reader to understand why the decision matters. ".repeat(4)}[Evidence](${first})`;
		const technical = `## Technical Details\n\n${"This section explains the mechanism, implementation boundaries, operational tradeoffs, failure modes, compatibility constraints, and validation path in concrete technical detail. ".repeat(4)}[Evidence](${second})`;
	return [
		acceptedNode("section-a", "section-writer", { ...envelope(findings), summary: { text: background, covers: [], omissions: [], confidence: "high" }, outputs: { document: { kind: "value", value: background } } }),
		acceptedNode("section-b", "section-writer", { ...envelope(findings), summary: { text: technical, covers: [], omissions: [], confidence: "high" }, outputs: { document: { kind: "value", value: technical } } }),
		acceptedNode("editor", "editor", { ...envelope(findings), summary: { text: `# Research report\n\n${background}\n\n${technical}`, covers: [], omissions: [], confidence: "high" }, outputs: { document: { kind: "value", value: `# Research report\n\n${background}\n\n${technical}` } } }, ["section-a", "section-b"]),
		acceptedNode("reviewer", "reviewer", { ...envelope([]), extensions: { release: { release: true, rationale: "Document passed review." } } }, ["editor"]),
	];
}

describe("workflow quality benchmark", () => {
	it("passes traced research, parallel section Writers, editor, and review", () => {
		const research = [validResearchNode("architecture"), validResearchNode("safety"), validResearchNode("recovery")];
		const report = assessWorkflowQuality(run([...research, ...documentNodes(research)]));

		assert.equal(report.releaseReady, true, report.blockers.join("\n"));
		assert.deepEqual(report.blockers, []);
		assert.equal(report.score, 100);
	});

	it("blocks snippet-only evidence and evidence URLs that were not fetched", () => {
		const snippetUrl = "https://example.test/snippet";
		const report = assessWorkflowQuality(run([
			acceptedNode("snippet", "research", envelope([finding("snippet claim", { url: snippetUrl })], { queries: ["snippet query"] })),
			validResearchNode("safety"),
			validResearchNode("recovery"),
		]));

		assert.equal(report.releaseReady, false);
		assert.ok(report.blockers.some((blocker) => blocker.toLowerCase().includes("trace")));
		assert.ok(report.blockers.some((blocker) => blocker.toLowerCase().includes("fetch")));
	});

	it("excludes file probes from web fetch coverage and traces local evidence independently of agent identity", () => {
		const fileProbe = "file:///opt/pi-agent-core/README.md";
		const local = acceptedNode("local-code", "research", envelope([
			finding("the installed package has no bundled README", { url: fileProbe, kind: "primary", quote: "ENOENT" }),
			finding("the local implementation mirrors a remote source", { url: "https://github.com/example/pi/blob/main/workflow.ts", artifactPath: "/repo/workflow.ts", kind: "primary", quote: "state reducer" }),
		]));
		const research = [local, validResearchNode("safety"), validResearchNode("recovery")];
		const report = assessWorkflowQuality(run([...research, ...documentNodes(research)]));

		assert.equal(report.releaseReady, true, report.blockers.join("\n"));
		assert.equal(report.metrics.researchTraceCoverage, 1);
		assert.equal(report.metrics.searchFetchCoverage, 1);
	});

	it("rejects local trace references that runtime validation cannot resolve", () => {
		const local = acceptedNode("missing-local", "research", envelope([
			finding("unresolved local claim", { artifactPath: "/missing/source.ts", quote: "not actually read" }),
		]));
		const report = assessWorkflowQuality(run([local, validResearchNode("safety"), validResearchNode("recovery")]), undefined, {
			validateLocalEvidence: () => false,
		});
		assert.equal(report.metrics.researchTraceCoverage, 2 / 3);
		assert.ok(report.blockers.some((blocker) => blocker.toLowerCase().includes("trace")));
	});

	it("does not exempt a local-researcher lane that returns no local or web trace", () => {
		const untraced = acceptedNode("untraced-local", "research", envelope([
			{ claim: "bare local claim", confidence: "high", evidence: [{ title: "unverified source" }] },
		]));
		untraced.agentSpec.baseAgent = "local-researcher";
		const report = assessWorkflowQuality(run([untraced, validResearchNode("safety"), validResearchNode("recovery")]));
		assert.equal(report.metrics.researchTraceCoverage, 2 / 3);
		assert.ok(report.blockers.some((blocker) => blocker.toLowerCase().includes("trace")));
	});

	it("matches fetched web evidence by canonical URL rather than raw annotation-sensitive text", () => {
		const evidenceUrl = "https://docs.example/guide?utm_source=test#section";
		const fetchedUrl = "https://docs.example/guide";
		const canonical = acceptedNode("canonical", "research", envelope([
			finding("canonical source", { url: evidenceUrl, kind: "primary", quote: "source text" }),
		], { queries: ["canonical source"], fetchedUrls: [fetchedUrl] }));
		const research = [canonical, validResearchNode("safety"), validResearchNode("recovery")];
		const report = assessWorkflowQuality(run([...research, ...documentNodes(research)]));

		assert.equal(report.releaseReady, true, report.blockers.join("\n"));
		assert.equal(report.metrics.searchFetchCoverage, 1);
	});

	it("does not block a source claim when one of its redundant evidence URLs was fetched", () => {
		const research = [validResearchNode("architecture"), validResearchNode("safety"), validResearchNode("recovery")];
		const findingWithRedundantSource = research[0]?.result?.evidence?.findings[0];
		assert.ok(findingWithRedundantSource);
		findingWithRedundantSource.evidence.push({
			url: "https://secondary.test/unavailable-copy",
			kind: "secondary",
			quote: "Redundant copy of the supported claim.",
		});
		const report = assessWorkflowQuality(run([...research, ...documentNodes(research)]));

		assert.equal(report.releaseReady, true, report.blockers.join("\n"));
		assert.equal(report.metrics.searchFetchCoverage, 1);
	});

	it("blocks accepted source claims without a URL or artifact reference", () => {
		const unsupported = finding("unsupported claim");
		unsupported.evidence = [{ title: "Search result snippet" }];
		const report = assessWorkflowQuality(run([
			acceptedNode("unsupported", "research", envelope([unsupported])),
			validResearchNode("safety"),
			validResearchNode("recovery"),
		]));

		assert.equal(report.releaseReady, false);
		assert.ok(report.blockers.some((blocker) => blocker.toLowerCase().includes("citation")));
	});

	it("accepts a semantic Writer paraphrase when its evidence traces to an accepted source", () => {
		const research = [validResearchNode("architecture"), validResearchNode("safety"), validResearchNode("recovery")];
		const documents = documentNodes(research);
		const editor = documents.find((node) => node.kind === "editor")!;
		const sourceUrl = research[0]?.result?.evidence?.findings[0]?.evidence[0]?.url;
		assert.ok(sourceUrl);
		editor.result = {
			...editor.result!,
			findings: [
				...editor.result!.evidence!.findings,
				finding("The platform recommendation follows from the documented operational behavior.", { url: sourceUrl }),
			],
		};
		const report = assessWorkflowQuality(run([...research, ...documents]));

		assert.equal(report.releaseReady, true, report.blockers.join("\n"));
		assert.equal(report.metrics.unsupportedWriterClaimRate, 0);
	});

	it("blocks Writer findings that introduce a new claim", () => {
		const research = [validResearchNode("architecture"), validResearchNode("safety"), validResearchNode("recovery")];
		const documents = documentNodes(research);
		const editor = documents.find((node) => node.kind === "editor")!;
		editor.result = { ...editor.result!, evidence: { ...editor.result!.evidence!, findings: [...editor.result!.evidence!.findings, finding("new writer claim", { artifactPath: "delivery/final.md" })] } };
		const report = assessWorkflowQuality(run([...research, ...documents]));

		assert.equal(report.releaseReady, false);
		assert.ok(report.metrics.unsupportedWriterClaimRate > 0);
		assert.ok(report.blockers.some((blocker) => blocker.toLowerCase().includes("writer")));
	});

	it("blocks accepted nodes that bypass correlated delegation provenance", () => {
		const research = [validResearchNode("architecture"), validResearchNode("safety"), validResearchNode("recovery")];
		const documents = documentNodes(research);
		const forgedWriter = documents.find((node) => node.kind === "editor")!;
		forgedWriter.attempts = [{
			attemptId: "writer:2",
			requestId: "supervisor-retry-writer",
			number: 2,
			startedAt: 1,
			completedAt: 2,
			status: "completed",
			result: forgedWriter.result,
			model: "supervisor-retry/accepted-draft",
		}];
		const report = assessWorkflowQuality(run([...research, ...documents.filter((node) => node.kind !== "editor"), forgedWriter]));

		assert.equal(report.releaseReady, false);
		assert.ok(report.metrics.delegationProvenanceCoverage < 1);
		assert.ok(report.blockers.some((blocker) => blocker.toLowerCase().includes("delegation")));
	});

	it("reports source-quality warnings without turning them into blockers", () => {
		const duplicateUrl = "https://community.test/copied";
		const weakNodes = ["one", "two", "three"].map((id) => acceptedNode(id, "research", envelope([
			finding(`${id} claim`, { url: duplicateUrl, kind: "community", confidence: id === "one" ? "medium" : "low" }),
		], { queries: [`${id} query`], fetchedUrls: [duplicateUrl] })));
		const report = assessWorkflowQuality(run([...weakNodes, ...documentNodes(weakNodes)]));

		assert.equal(report.releaseReady, true);
		assert.equal(report.warnings.length, 4);
		assert.ok(report.warnings.some((warning) => warning.toLowerCase().includes("primary")));
		assert.ok(report.warnings.some((warning) => warning.toLowerCase().includes("specificity") || warning.toLowerCase().includes("quote")));
		assert.ok(report.warnings.some((warning) => warning.toLowerCase().includes("duplicate")));
		assert.ok(report.warnings.some((warning) => warning.toLowerCase().includes("low-confidence") || warning.toLowerCase().includes("low confidence")));
		assert.equal(report.metrics.duplicateSourceRate, report.searchBenchmark?.duplicateSourceRate);
	});

	it("allows local artifact research without a web trace and becomes ready after resolving gaps and conflicts", () => {
		const gap = "Which branch is authoritative?";
		const conflict = "Recovery is cross-branch";
		const local = acceptedNode("local", "research", envelope([
			finding("local code claim", { artifactPath: "artifacts/source.txt", kind: "primary", quote: "branch guard" }),
		], {
			gaps: [{ question: gap, reason: "Needs a decision." }],
			conflicts: [{ statement: conflict, alternatives: ["yes", "no"], evidence: ["artifacts/source.txt"] }],
		}));
		local.agentSpec.baseAgent = "local-researcher";
		const research = [local, validResearchNode("safety"), validResearchNode("recovery")];
		const unresolved = assessWorkflowQuality(run([...research, ...documentNodes(research)]));
		assert.equal(unresolved.releaseReady, false);

		const resolved = assessWorkflowQuality(run([...research, ...documentNodes(research)], [
			{ id: "gap", kind: "gap_resolution", target: gap, rationale: "Verified locally." },
			{ id: "conflict", kind: "conflict_resolution", target: conflict, rationale: "Branch guard wins." },
		]));
		assert.equal(resolved.releaseReady, true);
		assert.equal(resolved.metrics.researchTraceCoverage, 1);
		assert.equal(resolved.metrics.unresolvedGaps, 0);
		assert.equal(resolved.metrics.unresolvedConflicts, 0);
	});

	it("excludes superseded research nodes from release metrics", () => {
		const obsolete = acceptedNode("obsolete", "research", envelope([
			finding("obsolete claim", { url: "https://old.example/source" }),
		], { queries: [], fetchedUrls: [] }));
		obsolete.status = "superseded";
		obsolete.supersededBy = "replacement";
		const replacement = validResearchNode("replacement");
		const research = [replacement, validResearchNode("safety"), validResearchNode("recovery")];
		const report = assessWorkflowQuality(run([obsolete, ...research, ...documentNodes(research)]));

		assert.equal(report.releaseReady, true, report.blockers.join("\n"));
		assert.equal(report.metrics.researchTraceCoverage, 1);
	});

	it("blocks a two-sentence editor draft even when the source lanes are fully traced", () => {
		const research = [validResearchNode("architecture"), validResearchNode("safety"), validResearchNode("recovery")];
		const documents = documentNodes(research);
		const editor = documents.find((node) => node.kind === "editor")!;
		editor.result = { ...editor.result!, summary: { text: "# Research report\n\nEvidence-backed synthesis.", covers: [], omissions: [], confidence: "high" }, outputs: { document: { kind: "value", value: "# Research report\n\nEvidence-backed synthesis." } } };
		const report = assessWorkflowQuality(run([...research, ...documents]));

		assert.equal(report.releaseReady, false);
		assert.ok(report.blockers.some((blocker) => blocker.toLowerCase().includes("outline")));
		assert.ok(report.blockers.some((blocker) => blocker.toLowerCase().includes("length")));
	});

	it("releases citation and length shortfalls when the Reviewer declares acceptance", () => {
		const research = [validResearchNode("architecture"), validResearchNode("safety"), validResearchNode("recovery")];
		const documents = documentNodes(research);
		// Short editor draft: fails length and citation-density gates but keeps outline headings.
		const editor = documents.find((node) => node.kind === "editor")!;
		editor.result = { ...editor.result!, summary: { text: "# Research report\n\n## Background\n\nShort background.\n\n## Technical Details\n\nShort details.", covers: [], omissions: [], confidence: "high" }, outputs: { document: { kind: "value", value: "# Research report\n\n## Background\n\nShort background.\n\n## Technical Details\n\nShort details." } } };
		// Reviewer declares it accepts the shortfalls.
		const reviewer = documents.find((node) => node.kind === "reviewer")!;
		reviewer.result = {
			...reviewer.result!,
			extensions: { release: { release: true, citationShortfallAccepted: true, lengthShortfallAccepted: true, rationale: "Short, focused deliverable is acceptable." } },
		};
		const blocked = assessWorkflowQuality(run([...research, ...documents]));
		assert.equal(blocked.releaseReady, true, blocked.blockers.join("\n"));
		assert.equal(blocked.reviewerRelease?.citationShortfallAccepted, true);
		assert.match(formatWorkflowQualityReport(blocked), /Reviewer release: citation-shortfall, length-shortfall/);
	});

	it("formats a release-oriented human quality summary", () => {
		const report = assessWorkflowQuality(run([
			acceptedNode("unsupported", "research", envelope([{ claim: "unsupported", confidence: "low", evidence: [{ title: "snippet" }] }])),
		]));
		const text = formatWorkflowQualityReport(report, "/repo/quality-report.json");
		assert.match(text, /Quality \d+\/100\s+BLOCKED/);
		assert.match(text, /Blockers:/);
		assert.match(text, /Coverage:/);
		assert.match(text, /citations/);
		assert.match(text, /quality-report\.json/);
	});

	it("accepted_uncertainty decisions count toward conflict resolution", () => {
		const research = validResearchNode("r1");
		const r1Result = research.result!;
		r1Result.diagnostics.conflicts = [
			{ statement: "ambiguous fact A", alternatives: ["alt1", "alt2"], evidence: [] },
			{ statement: "ambiguous fact B", alternatives: ["alt1", "alt2"], evidence: [] },
		];
		const nodes = [
			research,
			...documentNodes([research]),
		];
		// Without decisions: 2 unresolved conflicts.
		const withoutDecisions = assessWorkflowQuality(run(nodes, []));
		assert.equal(withoutDecisions.metrics.unresolvedConflicts, 2);
		// With accepted_uncertainty for one conflict: should resolve it.
		const withDecision = assessWorkflowQuality(run(nodes, [
			{ id: "d1", kind: "accepted_uncertainty", target: "ambiguous fact A", rationale: "cannot verify", at: 10 },
		]));
		assert.equal(withDecision.metrics.unresolvedConflicts, 1);
		// With conflict_resolution for the other: should resolve it too.
		const withBoth = assessWorkflowQuality(run(nodes, [
			{ id: "d1", kind: "accepted_uncertainty", target: "ambiguous fact A", rationale: "cannot verify", at: 10 },
			{ id: "d2", kind: "conflict_resolution", target: "ambiguous fact B", rationale: "resolved via PoC", at: 11 },
		]));
		assert.equal(withBoth.metrics.unresolvedConflicts, 0);
	});

	it("section writer coverage follows superseded chain", () => {
		const research = validResearchNode("r1");
		const nodes = documentNodes([research]);
		// Create a superseded section writer and its accepted replacement.
		const originalWriter: WorkflowNode = {
			id: "section-a",
			kind: "section-writer",
			label: "section-a",
			dependsOn: ["r1"],
			status: "superseded",
			supersededBy: "section-a-2",
			attempts: [],
			agentSpec: { id: "agent-a", baseAgent: "research-section-writer", role: "writer", objective: "a", instructions: "a", context: "fresh" },
			dataContract: { version: 1, profile: "writer", inputs: [], outputs: { document: { mediaType: "text/markdown", description: "doc", storage: "artifact", required: true, classification: "internal" } } },
		};
		const replacementWriter = acceptedNode("section-a-2", "section-writer", documentEnvelope("## Background\nReplacement section content with enough words to pass threshold."), ["r1"]);
		const allNodes = [...nodes.filter((n) => n.id !== "section-a"), originalWriter, replacementWriter];
		const report = assessWorkflowQuality(run(allNodes));
		// section-a is superseded by section-a-2 (accepted), so coverage should count it.
		assert.equal(report.metrics.sectionWriterCoverage, 1);
	});
});
