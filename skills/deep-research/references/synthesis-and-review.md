# Synthesis And Review

Before Section Writer launch, assemble:

- accepted findings and evidence;
- resolved conflicts and their decisions;
- accepted uncertainties;
- required outline, audience, and output format;
- prohibited claims and dropped sources.

Each Section Writer receives only explicit section ownership from the approved outline and writes those headings without adding a competing introduction or conclusion. Require material claims used by the prose to be mirrored in structured findings.

Readability is part of synthesis quality. Section Writers should lead with the reader's concrete question or decision, use one main idea per paragraph, explain key terms at first use, and use examples, tables, lists, or code only when they reduce understanding cost. The Lead Editor should prefer a shorter clear argument over a complete source dump.

Section Writers cannot search. They return their assigned Markdown in `summary`. The Lead Editor then reads every accepted section draft and produces the only complete final draft. It removes repetition, source-tour narration, and unnecessary detail, and repairs transitions without adding facts from memory.

The Reviewer checks:

- the opening gives the problem, conclusion, and reader payoff quickly;
- headings and first sentences expose the argument for a skimming reader;
- paragraphs, terminology, tables, lists, and code are organized for the intended audience;
- every material claim is present in accepted evidence;
- citations point to the claimed fact;
- conflicts and uncertainty are represented honestly;
- all requested dimensions are covered;
- recommendations follow from evidence;
- no new unsupported claim was introduced.
- the research brief and every approved outline section are covered at the requested depth;
- section ownership, target length, terminology, and cross-section transitions are respected;
- requested code, tables, diagrams, examples, operational details, or migration guidance are present.

The Reviewer may fetch a registered citation to validate it but cannot introduce a new claim. Repair the smallest failing section or editor responsibility, then review again while budget remains. If a release-critical gate still fails when the repair budget is exhausted, stop and report the unresolved blocker rather than silently delivering.

### Reviewer release

Reviewer node acceptance means the review result is valid; it does not mean the document passed. Accept a sound Reviewer result even when its verdict is fail, then repair or supersede the Editor draft from the named blockers. Reject the Reviewer node only when the review result itself is malformed, unsupported, or out of scope.

Every Reviewer must return top-level `review = { verdict: "pass" | "fail" }` inside the structured WorkflowResult. A passing Reviewer must additionally return top-level `extensions.release = { release: true, gapsAccepted?, conflictsAccepted?, citationShortfallAccepted?, lengthShortfallAccepted?, rationale }`; `rationale` is non-empty. Omit `extensions.release` when `review.verdict` is fail. These are control fields in the outer WorkflowResult, not prose and not an `outputs.result` file. The runtime returns a precise format steer to the same reviewer if the envelope is malformed. The release declaration approves that exact final Editor revision; the optional fields additionally release the corresponding residual gap, conflict, citation, or length gates so the supervisor is not forced to record each one manually. Be conservative: only release a gate when you have independently concluded the residual issue does not undermine the deliverable. Do not use release to bypass a blocker that actually requires repair.

## Do not damage prose to satisfy a gate

Outline and section coverage are satisfied by covering each section's reader questions and content, not by cosmetic marker matching. Never inject chapter-number or section-id markers (for example "本章编号 S3", "S1-S8") into headings or body sentences to make a heading string match an approved outline title. If a heading must align with the approved outline, edit the heading text itself; do not relocate labels into the prose. A gate that can only be passed by making the document uglier is a signal to fix the outline or the gate mapping, not the prose. Report an unresolvable gate as a blocker rather than satisfying it with scaffolding. This applies to every repair node, including a final repair pass.

Run `workflow.quality` before delivery. The final Markdown must exactly match the accepted Lead Editor `summary`. Quality checks include target length, outline coverage, Section Writer coverage, final citation density, unsupported final citations, and accepted-claim traceability.
