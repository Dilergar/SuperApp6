---
name: grill-me
description: Use when the user wants to stress-test a plan, feature, design, or set of requirements BEFORE implementation begins. Claude interviews the user relentlessly — one question at a time, each with a recommended answer — walking the design tree and resolving dependencies until there is a shared, unambiguous understanding. Triggers on phrases like "grill me", "grill me about", "interrogate the plan", "stress-test the design".
---

Interview the user relentlessly about every aspect of this plan until you reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your own recommended answer (with a one-line rationale).

Ask the questions one at a time (or in small, tightly-related batches), waiting for feedback before continuing. Let earlier answers reshape later questions — do not ask a fixed list mechanically.

If a question can be answered by exploring the codebase, explore the codebase instead of asking.

Keep going until there are no unresolved ambiguities that would change the implementation. Then — and only then — summarize the agreed design and proceed to a plan.
