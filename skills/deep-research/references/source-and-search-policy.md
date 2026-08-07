# Source And Search Policy

Search in two passes:

1. Broad first pass for coverage and candidate primary sources.
2. Narrow second pass only for release-critical gaps, conflicts, or freshness checks.

For the first parallel wave, use distinct source portfolios rather than cloning the same broad search: mechanism/official architecture, implementation/source code, operations/releases and failures, and alternatives/benchmarks and migration tradeoffs. Reusing a registered source is valid when it directly supports another claim, but every lane must contribute an independent decision dimension.

Source preference:

1. Official documentation, repositories, specifications, release notes, and first-party announcements.
2. Reproducible benchmarks, source code, and direct technical reports.
3. High-quality independent analysis with transparent evidence.
4. Community commentary only for experience claims, never as sole support for architecture or version facts.

Record dropped sources and why they were excluded. Deduplicate syndicated copies and pages that cite the same underlying source. For time-sensitive claims, record the source date and verify that the source is current.

Every core finding needs direct evidence. A search result snippet is discovery evidence, not final evidence; fetch or open the underlying source.

The structured handoff must preserve the search audit trail:

- `queries`: every broad and narrow query actually issued;
- `fetchedUrls`: every source opened beyond the result snippet;
- `droppedSources`: candidate URL and a concrete rejection reason;
- evidence `kind`: primary, secondary, or community;
- direct quote and source/retrieval dates when available.

Do not inflate query count. Stop when release-critical dimensions are covered, conflicts are resolved, and another query has lower decision value than its cost.

## Runtime evidence normalization

Accepted claims are normalized before Writer context is materialized:

- uncited claims (no URL and no artifact path) are dropped in Deep Research
- near-duplicate claims are merged
- evidence is ranked (primary > secondary > community; quote and citation preferred)
- tracking-query variants of the same URL are deduplicated
- distinct paths on the same domain are preserved

Search quality can be scored offline with the research-lane benchmark helper:

- source diversity
- claim support rate
- unsupported-claim rate
- cross-lane duplicate source rate
- fetch coverage

Prefer query rewrites that target primary sources and gap/conflict follow-ups over broad SEO pages.
