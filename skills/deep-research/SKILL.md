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
