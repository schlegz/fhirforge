# Design: chained search and `_include` / `_revinclude`

Status: **implemented** (2026-11-22). Roadmap: Next, item 1. Written alongside the code; the decisions below are open to revision in review.

## The constraint

A chained parameter (`Observation?subject.name=doe`) filters on the content of *another* resource. Done naively in SQL (a join from the Observation's reference index to the Patient's name index), it would let a caller test facts about patients they aren't allowed to read: "is there a patient named X with observations?". Includes have the same problem: an included resource is returned content. CLAUDE.md §7 says both are reads of that resource and need their own check.

## Decisions

**Chains run as their own search, through the policy.** Each chained value becomes a search on the target type (`Patient?name=doe`) through the normal search path. That means the policy's search filter, the per-result read check, and its own audit event (parameter names only). Its matches become an ordinary reference filter on the outer search (`subject=Patient/a,Patient/b`), ANDed with everything else. A chain can only ever match targets the caller may see, and nothing about hidden resources affects the outer result.

- One level only (`subject.organization.name` is a 400 `not-supported`).
- The target type comes from the modifier (`subject:Patient.name`), or from the parameter when exactly one of its targets is configured in the store; otherwise it's a 400 asking for the type. It must be a configured type.
- **Limits:** at most `MAX_CHAINS` (3) chained values per search. A chain matching more than `MAX_CHAIN_MATCHES` (100) targets is a 400 ("narrow it"), never a silently partial result. 100 is also the per-parameter value limit, so the rewritten reference filter always fits.
- A chain with no matches returns an empty result without running the outer query.
- The inner search can't use result parameters (`_count`, `_sort`, ...). Policy filters can't contain chains or includes.

**Includes are individual reads.** `_include=Observation:subject[:Patient]` reads each referenced resource through `read` (policy check and audit event each). `_revinclude=Observation:subject` runs a search on the referencing type through `search`, filtered to the page's results. A denied, missing or deleted target is left out without an error, so includes never reveal what exists.

- Targets come from the same compiled search-parameter paths that build the index (including `where(resolve() is Patient)` filters), only for configured types.
- Duplicates (already a match, or included twice) are dropped.
- **Limits:** at most `MAX_INCLUDE_PARAMS` (5) `_include` + `_revinclude` values, and `MAX_INCLUDED` (100) included resources per page. When the limit cuts some off, the result says so (`includeLimitReached`), and the REST handler adds an OperationOutcome warning entry (`search.mode: 'outcome'`).
- Not supported: `:iterate`, `*` wildcards.

## Cost

A chain costs one extra (bounded) search; an `_include` costs up to 100 reads. That's more queries than a join would take, accepted in exchange for exact policy enforcement. If it matters later, includes could batch their reads (one `IN` query, then the policy per row) without changing the semantics.

## Audit

Every inner search and include read is audited as its own event, before the outer search's event. The outer event lists the parameter names as sent, including the chain key (`subject.name`) and `_include`, never values.
