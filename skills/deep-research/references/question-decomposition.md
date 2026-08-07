# Question Decomposition

Before decomposition, establish a research brief covering audience, purpose, scope, depth, deliverable type, target length, required topics, exclusions, constraints, and assumptions. Ask 3-5 concise user questions when these materially affect the result. Clarification is choice-first: provide 2-6 clear options with optional short descriptions and put the recommended/default option first. Use multiple choice only when combining options is meaningful. The UI always includes Other so the user can add context that the prepared choices missed. Do not ask questions whose answers can be safely inferred from an explicit request.

The brief must also record the deliverable class (research report vs publishable article), because it selects the production pipeline and the completion gates. See the scope guard in `SKILL.md`.

## Disambiguate core terms first (hard rule)

Resolve core-term meaning before scope, depth, or outline. When a core term in the goal is polysemous, or has more than one plausible reading that would change the deliverable, the disambiguation must be a choice-first clarification question asked to the user. Example: "loop engineering" can mean a ReAct / tool-calling agent loop, or a persistent goal-driven loop in a coding harness (`/goal`, Sisyphus, Ralph-style continuous execution); these lead to entirely different articles.

- Never resolve a core-term ambiguity with a silent brief assumption.
- Never substitute a reconnaissance wave for the disambiguation question. Reconnaissance refines scope after the meaning is fixed; it does not decide which meaning the user intended.
- Any interpretation written into the brief that the user did not explicitly state or confirm is an unconfirmed assumption. Surface each such assumption for confirmation before it drives the outline.
- Keep document-production planning blocked until both the core-term reading and the deliverable class are confirmed. Approving an outline built on an unconfirmed term reading does not count as confirming the term; the term must be confirmed on its own.

When terminology or scope is uncertain after the core term is fixed, create a small reconnaissance wave before finalizing the outline. Then create at least three independent evidence lanes for a substantive Deep Research request. Prefer dimensions that can fail independently, such as:

- architecture and mechanism;
- current implementation and source evidence;
- safety, recovery, and operational constraints;
- alternatives and comparative tradeoffs;
- adoption cost and compatibility.

Each lane needs a distinct decision contribution. Do not split only by search keywords or project names when every child would answer the same comparison question.

The approved outline must map every section to reader questions, evidence requirements, a target word budget, and one Section Writer owner. Use at least two Writer owners so substantial sections can be drafted in parallel without overlapping ownership. Submit the draft through `set_outline` with `approval=user` so Pi opens the inline approval/revision form. Do not treat ordinary chat text such as "please confirm" as approval.
