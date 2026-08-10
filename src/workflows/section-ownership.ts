import type { DocumentOutline, DocumentOutlineSection, WorkflowNode, WorkflowWorkUnitPlan } from "./types.ts";

/** Returns the explicit owners, while accepting persisted legacy single-owner outlines. */
export function sectionWriterNodeIds(section: DocumentOutlineSection): string[] {
	const explicit = section.writerNodeIds?.filter((id) => id.trim()) ?? [];
	if (explicit.length > 0) return [...new Set(explicit)];
	return section.writerNodeId?.trim() ? [section.writerNodeId] : [];
}

export function outlineSectionWriterNodeIds(outline: DocumentOutline | undefined): Set<string> {
	return new Set((outline?.sections ?? []).flatMap(sectionWriterNodeIds));
}

export function sectionIsOwnedBy(section: DocumentOutlineSection, nodeId: string): boolean {
	return sectionWriterNodeIds(section).includes(nodeId);
}

type PlannedOrPersistedNode = Pick<WorkflowWorkUnitPlan | WorkflowNode, "id" | "kind">;

/**
 * Rejects unresolvable outline ownership before document production begins. This
 * prevents an immutable outline from being committed with IDs that cannot run.
 */
export function assertOutlineSectionWriterOwnership(outline: DocumentOutline, nodes: Iterable<PlannedOrPersistedNode>): void {
	const byId = new Map([...nodes].map((node) => [node.id, node]));
	const available = [...byId.values()].filter((node) => node.kind === "section-writer").map((node) => node.id).sort();
	for (const section of outline.sections) {
		const owners = sectionWriterNodeIds(section);
		if (owners.length === 0) {
			throw new Error(`Outline section '${section.id}' must declare writerNodeId or writerNodeIds.`);
		}
		for (const ownerId of owners) {
			const node = byId.get(ownerId);
			if (!node || node.kind !== "section-writer") {
				throw new Error([
					`Outline section '${section.id}' references Section Writer '${ownerId}', but no work unit with that id and kind 'section-writer' exists.`,
					`Available Section Writer nodes: ${available.length ? available.join(", ") : "none"}.`,
					"Correct writerNodeId/writerNodeIds or add a matching section-writer work unit before starting document production.",
				].join(" "));
			}
		}
	}
}
