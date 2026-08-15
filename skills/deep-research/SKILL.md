---
name: deep-research
description: Produce a source-grounded research deliverable through parallel research lanes, targeted verification, accepted-claim synthesis, and independent review.
---

# Deep Research

Use together with `dynamic-workflow` in the root Pi session.

## Scope guard: research deliverable vs publishable article

Deep Research produces a source-grounded research deliverable (a report). Its optimized objectives are coverage, citations, evidence traceability, and outline conformance. It does not optimize the reading experience of a publishable article.

Decide the deliverable class from the clarified brief before starting, and route accordingly:

- Research report, briefing, evidence review, technical analysis, comparison memo -> use this skill with `mode=deep-research`.
- Publishable article, 公众号/长文, opinion or narrative piece where the reading experience is the product -> do NOT run the Deep Research report pipeline. Route to the article pipeline: `positioning` -> `writer` -> `human-writing` -> `qa` skills, orchestrated in `general` mode. Deep Research may still run first as an upstream evidence phase whose accepted findings feed `writer`, but it must not be the delivery pipeline.

Choosing `mode=deep-research` locks in report gates (citation density, claim traceability, literal outline coverage, minimum length, evidence tables). These gates make an article worse: they reward source dumps, mechanical structure, and marker scaffolding over prose quality. If the reader wants something enjoyable to read, do not soften the report gates — switch pipelines. `general` mode already disables the report gates, so the article pipeline runs without them by construction.

### Article output-format profile and pre-delivery gate

When the deliverable is a publishable article, apply this profile to the delivered artifact and treat `human-writing`/`qa` as a required pre-delivery gate, not a post-hoc audit:

- No local absolute filesystem paths in the artifact.
- No evidence-traceability tables or per-claim source appendices in the body; keep sourcing in notes or omit it for general audiences.
- No chapter-number or section-id markers ("本章编号 Sx", "S1-S8") in headings or prose.
- Bound mechanical scaffolding density: Chinese colons, em-dashes, and bold runs should read as authored prose, not as a report.
- Respect a comfortable length ceiling for the target channel; a 公众号 长文 is far shorter than an eight-chapter report.
- Not release-ready until a `human-writing` pass and a `qa` pass approve it. A research-report reviewer PASS does not certify a publishable article.

Read:

1. `references/question-decomposition.md`
2. `references/source-and-search-policy.md`
3. `references/conflict-and-gap-policy.md`
4. `references/synthesis-and-review.md`

Default long-form workflow:

```text
research brief (clarified or explicitly inferred)
  -> optional reconnaissance and Outline Architect
  -> set_outline with approval=user
  -> inline user approval or revision feedback
  -> three or more independent research lanes
  -> evaluate claims, sources, gaps, and conflicts
  -> zero or more targeted verifier nodes
  -> accepted material
  -> two or more parallel Section Writers
  -> one Lead Editor
  -> one independent Reviewer
  -> focused section/editor repairs until gates pass or budget stops
  -> delivery/final.md
```

Do not confuse parallel research with parallel whole-document writing. Section Writers own non-overlapping outline sections; the Lead Editor is responsible for cross-section coherence and the only accepted final draft.

Do not print a standalone outline followed by a passive confirmation request when Pi UI is available. Call `set_outline` with `approval=user`; the runtime must persist the outline only after the user approves it in the inline review form. Revision feedback returns to the Supervisor and keeps document-production planning blocked until a revised outline is approved.

Do not force certainty. A correct Deep Research result may contain explicit unresolved uncertainty when public evidence is insufficient.

## Visualization & readability (mandatory for delivery)

Deep Research output must be more than a wall of text. Readability is part of synthesis quality. Use a **progressive image priority** when producing the final report:

1. **P0 — Official assets**: Research lanes should record official diagrams/logos/architecture figures when they encounter them in primary sources (URLs in `evidence.search.fetchedUrls`). The Lead Editor may reference these directly when the source explicitly publishes a diagram.
2. **P1 — Auto-generated SVG diagrams**: The default and primary visualization path. The Lead Editor MUST use the `report-svg-diagrams` skill to generate standalone, deterministic SVG diagrams (comparison matrix / bar / radar, layered architecture, flow, timeline) for any report that compares systems or explains structure/flow. Write `.svg` files and reference them in the markdown with a one-line caption.
3. **P2 — Generative image MCP (optional)**: For non-technical / hero / evocative images only, when a configured image-generation MCP (e.g. `image-this`) is available. Never use generative images for factual data that must be exact — prefer P1 SVG.

Only encode values confirmed in accepted evidence in any diagram. Never invent numbers or labels for a figure. The Reviewer must verify diagram presence, takeaway clarity, and data consistency with the prose.

SVG must be authored to be **scalable, fully visible, and never cropped**:
- Root element MUST use `viewBox="0 0 <W> <H>"` plus `width="100%" height="100%"` plus `preserveAspectRatio="xMidYMid meet"`.
- `meet` guarantees the whole diagram scales to fit (never clipped); `max-width:100%;height:auto` on the `<img>` guarantees it shrinks to the container and never overflows/crops.
- Do NOT use fixed pixel `width`/`height` on the `<svg>` — that is the #1 cause of cropping/overflow in narrow viewers.
- Leave ≥20px padding inside the canvas so content is never clipped at the edges.
- Reference in markdown as `<img src="assets/xxx.svg" alt="..." style="max-width:100%;height:auto">` followed by a one-line caption.
