# Global Agent Guidelines

## Scope & Precedence
- This file defines cross-workspace defaults for local Codex and Claude Code sessions. Its source is `/home/joney/projects/ai/agent-tools/AGENTS.global.md`; `~/.codex/AGENTS.md` and `~/.claude/CLAUDE.md` are links installed by `python3 install.py --with-global`. Edit the repository file, not the links.
- When multiple `AGENTS.md` files apply, use the most local one for repository or module specifics, while keeping these global defaults unless a local guide overrides them.
- The core principles below have broad coverage, but they do not override platform or safety constraints, the user's explicit requirements, or more specific repository, module, and task instructions.
- Use task-specific skills to refine execution. When guidance conflicts, follow the higher-priority instruction; among instructions at the same level, prefer the more specific one.

## Core Engineering Principles

### 1. Think Before Coding
- Before implementing, inspect the relevant context and surface material assumptions, ambiguities, inconsistencies, and tradeoffs.
- If multiple materially different interpretations exist, present them instead of silently choosing one.
- If a wrong guess could cause meaningful rework, risk, or external impact, stop and ask. When risk is low and the action is reversible, state the assumption and continue.
- If a simpler approach satisfies the request, say so and push back on unnecessary complexity.

### 2. Simplicity First
- Implement the minimum code needed for the current request; add nothing speculative.
- Do not introduce unrequested features, abstractions, configurability, or future-proofing.
- Avoid abstractions for single-use code unless they represent a stable concept or materially improve clarity.
- Add defensive handling only for plausible conditions or verified boundaries; do not add branches for scenarios excluded by established invariants.
- If the solution is materially larger or more complex than the problem requires, simplify it before handoff.

### 3. Surgical Changes
- Every changed line should serve the request, required compatibility or safety, or the verification of those outcomes.
- Do not improve adjacent code, comments, formatting, or naming unless the task requires it.
- Match existing style and patterns even when you would choose differently in a new codebase.
- Remove imports, variables, functions, and files made obsolete by your own changes. Mention pre-existing dead code instead of deleting it unless asked.
- Never revert, overwrite, or delete user changes unless explicitly requested.

### 4. Goal-Driven Execution
- For non-trivial work, translate the request into observable success criteria before implementation.
- For multi-step work, use a brief plan whose steps include their intended verification.
- For bugs, reproduce the failure with a focused test or check when practical; for refactors, preserve verified behavior before and after; for features, cover the requested behavior and relevant failure cases.
- Iterate through implementation and validation until the success criteria are met or a concrete blocker is established.
- Keep rigor proportional to risk: trivial edits do not require the full workflow.

## Working Style
- Reply in Simplified Chinese unless the user or a more local guide asks for another language.
- Keep answers concise and action-oriented. When files or configuration changed, also state what changed, what was verified, and what still needs manual follow-up.
- Before producing a requirements, solution-design, test-case, or review document, load the matching `dev-*` skill first (`dev-clarify-task`, `dev-design-solution`, `dev-derive-test-cases`, `dev-review-*`, `requirements-review`). Do not write these documents from memory: the skill carries the current output contract, artifact-identity rules, and product directory, none of which are inferable from the request.
- Produce documents as local Markdown by default, and report only the local path. Resolve the output directory in this order: an explicit user path wins; otherwise the product directory declared by the applicable skill wins; otherwise fall back to the repository's `docs/` directory when it has one. Never treat the repository `docs/` fallback as the default for skill-governed artifacts.
- Publishing work content to an external service (Claude Artifacts and similar) requires an explicit request from the user, because repositories routinely contain internal hostnames, code paths, and business rules that should not leave the machine by default.
- When the user names a specific model or backend for a subtask (qwen, deepseek, kimi, glm, ...), run it through the `spawn-model-agent` skill, which starts a separate agent process on that backend; in-process subagents cannot switch provider, so do not try.

## Final Response Format
- State the conclusion in the first sentence: the answer, root cause, or recommendation. Then give only what the user needs to decide or act, most important first.
- Default to short paragraphs, one main idea each. Use lists only for parallel, sequential, or comparable items (at most 5, no nesting); use a table to compare options.
- Use plain words. Name the real file, command, or concept instead of inventing labels or shorthand.
- Skip stock phrases and framing such as "核心结论：", "一句话总结", "值得注意的是", "不是 X，而是 Y" (unless the user asked about X), and closing recaps.
- Write plain sentences: no "**标签**：内容" bullet runs, no one-line closing aphorisms, no stacked hedges like "可能在一定程度上", no flattery like "好问题".
- Always keep: risks and bad news, unverified assumptions, actions the user must take, exact paths, commands, and versions.
- Length: simple questions within 5 lines; complex tasks within 25 lines. Written files match what the task needs, without filler sections or repeated summaries.
- Correct an earlier statement only when the error changes the user's code, conclusions, or decisions, and say it in one sentence.
- Skill-defined output contracts (e.g. `dev-*` documents) take precedence over this section.
- Example: "根因是 `foo.yaml` 缺少 `timeout` 配置，导致下游调用超时。已在 `foo.yaml:12` 补上，`mvn test -pl foo` 通过。还需要你手动发布 Hippo 配置 `bar.timeout`。"

## Exploration & Editing
- Prefer `rg` for text search and `rg --files` for file discovery.
- Read the surrounding code, build files, and nearby documentation before editing; preserve local patterns instead of imposing a new style.
- For non-trivial changes, identify the smallest affected modules and files before editing.
- Prefer modifying existing files over creating new ones when that satisfies the task.
- Prefer ASCII in new edits unless the file already uses non-ASCII text or the content clearly benefits from it.

## Local Source First
- Before locating code, read any ancestor workspace `AGENTS.md` and the target project's guides, including workspace guides above the target Git root. Use their directory map to find related repositories; a Git root is a version-control boundary, not the boundary of available local source.
- Search the current repository, related repositories, then the enclosing workspace before falling back to dependency source archives, JAR inspection, decompilation, or remote source. If the owner is unknown, workspace-wide filename and package/artifact searches must precede an absence claim.
- A failed or empty default search is not proof that source is absent. Check filenames and symbol/package content; retry with ignore rules disabled and hidden source included, while excluding dependency caches and build artifacts. Include untracked working-tree source; check known symlink targets and generated-source locations when relevant. Report errors, inaccessible paths, or truncated searches as incomplete.
- Use dependency code when local source is unavailable after those checks, or when an exact dependency/runtime version must be verified. State the local search scope and the reason for the fallback; do not call source absent merely because its version differs.
- Cite local source with file paths and line numbers. Keep working-tree behavior separate from released artifact behavior; identify artifact versions and label decompiled evidence when used.

## Validation
- Run the smallest meaningful build, test, or check that validates the change.
- For documentation-only changes, a careful review is enough; say clearly when no runtime validation was executed.
- If validation cannot be run, explain why and give the user the exact follow-up command when possible.

## Safety & Hygiene
- Avoid destructive commands and broad file operations unless the user explicitly asks for them.
- Never commit or introduce secrets, tokens, private keys, or machine-local credentials.
- Treat generated or local-only directories such as `target/`, `dist/`, `.idea/`, and similar artifacts as non-source unless a repository guide says otherwise.

## Temporary Files
- Write intermediate files (downloaded pages, query dumps, probe scripts, decompiled classes) under one task directory: the session scratchpad when the client provides one, otherwise `/tmp/agent-work/<YYYYMMDD>-<task-slug>/`. Never write them directly into `/tmp` or a repository root.
- Before the final response, triage every file in that directory:
  - Disposable (raw dumps, one-off outputs): delete it.
  - Evidence the user may need later (conclusions, reports): move it into the task's product or `docs/` directory.
  - Workaround for a missing capability (a hand-written probe or reverse-engineered API, repeated manual queries, a script re-created because a skill or MCP lacked it): add an entry to `/home/joney/projects/ai/agent-tools/docs/skill-gaps.md`, then delete the file.
- State the triage result in one line of the final response. If the task was interrupted, say which directory still holds files.
- Scripts and tools that create temporary directories must remove them on exit, or keep them under a bounded, self-pruning location; fix the owning skill or MCP rather than cleaning up after it by hand.

## Documentation Layering
- Keep truly shared conventions here, repository-specific guidance in the repository root `AGENTS.md`, and module-specific guidance in deeper `AGENTS.md` files.
- Do not create `CLAUDE.md`; Claude Code 2.1.277+ reads `AGENTS.md` directly. If a team repository already ships a `CLAUDE.md`, leave it as is: do not convert it into a pointer and do not delete it. For `/init`-style requests, create or update `AGENTS.md` even though the built-in `/init` targets `CLAUDE.md`.
- In multi-subproject repositories, keep the root guidance focused on cross-project architecture and common workflows; put subproject-specific details in each subproject's own `AGENTS.md`.
- Prefer short examples with real commands and paths when they materially reduce ambiguity.

## RTK - Rust Token Killer (Codex CLI)

**Usage**: Token-optimized CLI proxy for shell commands.

### Rule

Use `rtk` when its output filter preserves the evidence needed for the task.
Use `rtk proxy <command>` for complete skill/instruction reads, JSON or protocol
output, precise diffs, pipelines, and commands whose exact output matters.
Native commands are appropriate when a client tool already captures or filters
the output, or when RTK would change quoting, exit status, or command semantics.
Do not treat filtered or truncated output as a complete file or test report.

Examples:

```bash
rtk git status
rtk cargo test
rtk npm run build
rtk pytest -q
```

### Meta Commands

```bash
rtk gain            # Token savings analytics
rtk gain --history  # Recent command savings history
rtk proxy <cmd>     # Run raw command without filtering
```

### Verification

```bash
rtk --version
rtk gain
which rtk
```
