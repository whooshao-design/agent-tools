from __future__ import annotations

import importlib.util
import tomllib
import unittest
from pathlib import Path


REPO = Path(__file__).parents[1]
WORKFLOW = REPO / "skills/dev-workflow"
HOOK_PATH = REPO / "hooks/subagent_result_guard.py"
HOOK_SPEC = importlib.util.spec_from_file_location("subagent_result_guard", HOOK_PATH)
assert HOOK_SPEC and HOOK_SPEC.loader
hook = importlib.util.module_from_spec(HOOK_SPEC)
HOOK_SPEC.loader.exec_module(hook)


REVIEWERS = {
    "agent-tools-requirements-reviewer": (
        "requirements-review",
        {"通过", "有条件通过", "不通过", "材料不足"},
    ),
    "agent-tools-solution-reviewer": (
        "dev-review-solution",
        {"通过", "有条件通过", "修改后复审", "退回重设计", "材料不足"},
    ),
    "agent-tools-test-design-reviewer": (
        "dev-review-test-cases",
        {"通过", "修改后复审", "方案缺口", "材料不足"},
    ),
    "agent-tools-change-reviewer": (
        "dev-review-change",
        {"可继续推进", "修复后再评", "带风险接受", "证据不足"},
    ),
}


class WorkflowContractTest(unittest.TestCase):
    def test_reviewer_roles_and_conclusions_stay_in_sync(self):
        contract = (WORKFLOW / "references/delegation-contract.md").read_text(
            encoding="utf-8"
        )
        self.assertEqual(set(REVIEWERS), set(hook.ALLOWED_CONCLUSIONS))

        for role, (skill, conclusions) in REVIEWERS.items():
            self.assertEqual(conclusions, set(hook.ALLOWED_CONCLUSIONS[role]))
            self.assertIn(role, contract)
            skill_text = (WORKFLOW / skill / "SKILL.md").read_text(
                encoding="utf-8"
            )
            for conclusion in conclusions:
                self.assertIn(conclusion, contract)
                self.assertIn(conclusion, skill_text)

            for client, suffix in (("claude", ".md"), ("codex", ".toml")):
                agent = (
                    REPO / "agents" / client / f"{role}{suffix}"
                ).read_text(encoding="utf-8")
                self.assertIn(role, agent)
                self.assertIn(skill, agent)
                for conclusion in conclusions:
                    self.assertIn(conclusion, agent)

    def test_claude_reviewers_have_read_only_tool_allowlist(self):
        for path in (REPO / "agents/claude").glob("agent-tools-*.md"):
            text = path.read_text(encoding="utf-8")
            self.assertIn("tools: Read, Grep, Glob", text, path)
            self.assertIn("disallowedTools: Agent", text, path)
            self.assertIn("permissionMode: plan", text, path)

    def test_risk_authorization_requires_a_new_independent_round(self):
        contract = (WORKFLOW / "references/delegation-contract.md").read_text(
            encoding="utf-8"
        )
        self.assertIn("属于新增冻结输入", contract)
        self.assertIn("新的 `task_id` 和 `round`", contract)
        self.assertIn("旧结论保持不变", contract)
        for skill in ("requirements-review", "dev-review-solution"):
            text = (WORKFLOW / skill / "SKILL.md").read_text(encoding="utf-8")
            self.assertIn("风险授权是新的评审输入", text, skill)
            self.assertIn("重新派发", text, skill)

    def test_solution_review_handoff_cannot_bypass_waiver_context(self):
        text = (WORKFLOW / "dev-review-solution/SKILL.md").read_text(
            encoding="utf-8"
        )
        self.assertIn("跳过 `test-design-review`", text)
        self.assertIn("waiver-record-v1", text)
        self.assertIn("G={mode: waived,W:{ref,fingerprint}}", text)
        self.assertNotIn("可直接转 `dev-build-change` 并记录跳过风险", text)

    def test_solution_template_is_conclusion_first_and_delta_driven(self):
        template = (
            WORKFLOW
            / "dev-design-solution/references/solution-template.md"
        ).read_text(encoding="utf-8")

        headings = (
            "## 0. 一页结论",
            "## 1. 背景与现状",
            "### 3.4 变更地图",
            "## 4. 详细设计",
        )
        positions = [template.index(heading) for heading in headings]
        self.assertEqual(sorted(positions), positions)

        for token in (
            "CHG-001",
            "新增 / 修改 / 删除 / 保持不变",
            "#### 当前行为与证据",
            "#### 本次调整",
            "#### 调整后行为与不变量",
            "明确保持不变的相邻逻辑",
        ):
            self.assertIn(token, template)

        for old_heading in (
            "### 4.1 模块改动",
            "### 4.2 接口设计",
            "### 7.2 模块职责与调用关系",
        ):
            self.assertNotIn(old_heading, template)

    def test_solution_structure_contract_is_mece_and_traceable(self):
        contract = (
            WORKFLOW / "references/solution-structure-contract.md"
        ).read_text(encoding="utf-8")

        for token in (
            "导航视图与权威正文",
            "每个父章节只能选择一个划分维度",
            "同级章节必须处于相同抽象层级",
            "内容唯一归属",
            "每个 `AC-*` 至少映射一个 `CHG-*`",
            "孤儿变更",
            "变更地图与详细设计的 CHG 集合必须完全一致",
            "正文目标不超过约 300 行",
            "超过约 450 行",
        ):
            self.assertIn(token, contract)

    def test_solution_review_enforces_structure_without_style_policing(self):
        skill = (WORKFLOW / "dev-review-solution/SKILL.md").read_text(
            encoding="utf-8"
        )
        template = (
            WORKFLOW / "dev-review-solution/references/review-template.md"
        ).read_text(encoding="utf-8")

        for token in (
            "先做结构与追踪准入",
            "按 CHG 逐项评审",
            "不得只抽查部分 CHG 后给出整体通过",
            "`层级错位` / `结构重叠` / `覆盖缺口` / `孤儿变更`",
            "纯标题偏好、个人文风或不影响理解的措辞不升级为问题",
            "`AC-* → CHG-* → 验证/发布`",
        ):
            self.assertIn(token, skill)

        self.assertIn("AC→CHG→验证/发布", template)
        self.assertIn("只有影响决策、实施或验证时才记录", template)
        self.assertIn("## 3. CHG 逐项评审覆盖", template)
        self.assertIn("DEC-001 / CHG-001 / AC-001 / RISK-001", template)

        headings = (
            "## 0. 一页评审结论",
            "## 1. Findings 摘要",
            "## 3. CHG 逐项评审覆盖",
            "## 7. 评审对象与执行",
            "## 8. 评审历史",
        )
        positions = [template.index(heading) for heading in headings]
        self.assertEqual(sorted(positions), positions)

    def test_solution_targeted_rereview_keeps_global_safety_checks(self):
        design = (WORKFLOW / "dev-design-solution/SKILL.md").read_text(
            encoding="utf-8"
        )
        review = (WORKFLOW / "dev-review-solution/SKILL.md").read_text(
            encoding="utf-8"
        )
        template = (
            WORKFLOW / "dev-review-solution/references/review-template.md"
        ).read_text(encoding="utf-8")
        codex_agent = (
            REPO / "agents/codex/agent-tools-solution-reviewer.toml"
        ).read_text(encoding="utf-8")
        claude_agent = (
            REPO / "agents/claude/agent-tools-solution-reviewer.md"
        ).read_text(encoding="utf-8")
        auto_loop = (
            WORKFLOW / "dev-auto-loop/references/design-review-loop.md"
        ).read_text(encoding="utf-8")

        self.assertIn("新旧方案差异和影响范围", design)
        self.assertIn("全局结构", design)
        self.assertIn("追踪与非回归检查", design)
        for text in (review, template, codex_agent, claude_agent, auto_loop):
            self.assertIn("定点复审", text)
            self.assertIn("全局结构", text)
            self.assertIn("非回归", text)

        self.assertIn("无法可靠证明时，必须完整复审", template)
        self.assertIn("重新设计一律完整复审", auto_loop)

    def test_change_review_template_supports_direct_context(self):
        skill = (WORKFLOW / "dev-review-change/SKILL.md").read_text(
            encoding="utf-8"
        )
        template = (
            WORKFLOW / "dev-review-change/references/review-template.md"
        ).read_text(encoding="utf-8")
        self.assertIn("审批/direct/waiver 记录", skill)
        self.assertIn("direct: `D={ref,fingerprint}`", template)
        self.assertIn("direct-record-v1", template)

    def test_codex_reviewers_disable_inherited_mcp_defaults(self):
        for path in (REPO / "agents/codex").glob("agent-tools-*.toml"):
            config = tomllib.loads(path.read_text(encoding="utf-8"))
            self.assertEqual("read-only", config.get("sandbox_mode"), path)
            self.assertEqual({}, config.get("mcp_servers"), path)

    def test_execution_modes_are_supported_by_delivery_stages(self):
        identity = (WORKFLOW / "references/artifact-identity.md").read_text(
            encoding="utf-8"
        )
        for mode in ("approved", "direct", "waived"):
            self.assertIn(f"mode: {mode}", identity)

        for skill in (
            "dev-build-change",
            "dev-verify-change",
            "dev-finish-branch",
        ):
            text = (WORKFLOW / skill / "SKILL.md").read_text(encoding="utf-8")
            self.assertIn("G.mode", text, skill)
            for mode in ("approved", "direct", "waived"):
                self.assertIn(f"`{mode}`", text, (skill, mode))

    def test_governance_path_and_delivery_context_are_distinct(self):
        identity = (WORKFLOW / "references/artifact-identity.md").read_text(
            encoding="utf-8"
        )
        loop = (WORKFLOW / "dev-auto-loop/SKILL.md").read_text(
            encoding="utf-8"
        )
        self.assertIn("governance_path=approved", identity)
        self.assertIn("不得提前声称 `G.mode=approved`", identity)
        self.assertIn("governance_path=approved", loop)
        self.assertIn("此时还不存在交付 `G.mode=approved`", loop)

    def test_auto_loop_state_is_checkpointed_and_resumable(self):
        loop = (WORKFLOW / "dev-auto-loop/SKILL.md").read_text(
            encoding="utf-8"
        )
        state = (
            WORKFLOW
            / "dev-auto-loop/references/run-state-and-resume.md"
        ).read_text(encoding="utf-8")

        for token in (
            "auto-loop-run-v1",
            "auto-loop-checkpoint-v1",
            "`run_id`",
            "previous",
            "{ref,fingerprint}",
            "status.md",
            "不能作为计数、审批或恢复事实源",
            "同一 run 的所有已用计数保持不变",
        ):
            self.assertIn(token, state)
        self.assertIn("最新 checkpoint", loop)
        self.assertIn("恢复同一 run", loop)

    def test_auto_loop_evidence_attempts_have_per_gap_and_total_limits(self):
        loop = (WORKFLOW / "dev-auto-loop/SKILL.md").read_text(
            encoding="utf-8"
        )
        design = (
            WORKFLOW / "dev-auto-loop/references/design-review-loop.md"
        ).read_text(encoding="utf-8")
        test_cases = (
            WORKFLOW / "dev-auto-loop/references/test-case-review-loop.md"
        ).read_text(encoding="utf-8")

        self.assertIn("每段的 `evidence_auto_attempt_limit` 默认均为 3", loop)
        self.assertIn("design.evidence_auto_attempt_count", design)
        self.assertIn("test_cases.evidence_auto_attempt_count", test_cases)
        self.assertIn("停止为 `blocked_material`", loop)
        self.assertIn("`budget_exhausted` 仅用于", loop)
        self.assertNotIn("通用阶段转移预算", design)

    def test_auto_loop_routes_structured_producer_outcomes(self):
        loop = (WORKFLOW / "dev-auto-loop/SKILL.md").read_text(
            encoding="utf-8"
        )
        state = (
            WORKFLOW
            / "dev-auto-loop/references/run-state-and-resume.md"
        ).read_text(encoding="utf-8")
        derive = (WORKFLOW / "dev-derive-test-cases/SKILL.md").read_text(
            encoding="utf-8"
        )

        self.assertIn("producer-stage-result-v1", loop)
        for outcome in (
            "`produced`",
            "`upstream_gap`",
            "`blocked_material`",
            "`blocked_infrastructure`",
            "`awaiting_human`",
            "`execution_failed`",
        ):
            self.assertIn(outcome, state)
        self.assertIn("producer 自评不能直接推翻已有方案审批", derive)
        self.assertIn("运行时 `agent_ref` 不属于 producer 自报结果字段", state)
        self.assertIn("工作区事件或前后快照核对实际写集", state)
        self.assertIn("auto-loop 不包含需求修订子循环", loop)
        self.assertNotIn("如显式进入需求评审", loop)

    def test_build_derives_traceable_development_items_before_coding(self):
        build = (WORKFLOW / "dev-build-change/SKILL.md").read_text(
            encoding="utf-8"
        )
        contract = (
            WORKFLOW
            / "dev-build-change/references/development-checklist.md"
        ).read_text(encoding="utf-8")
        identity = (WORKFLOW / "references/artifact-identity.md").read_text(
            encoding="utf-8"
        )

        self.assertLess(
            build.index("### 3. 拆分开发执行清单"),
            build.index("### 4. 按依赖实施最小必要改动"),
        )
        for token in (
            "AC → CHG → DEV → TC → 验证",
            "不把执行清单升级成新的审批产物",
            "简单任务允许只有一个内联 `DEV-001`",
            "编码前检查范围覆盖",
        ):
            self.assertIn(token, build)

        for token in (
            "`AC-* → CHG-* → DEV-* → TC-* → 验证结果`",
            "`Planned` / `InProgress` / `Done` / `Blocked` / `Skipped`",
            "每个范围内 `CHG-*` 至少映射一个 DEV",
            "每个范围内 `TC-*` 都映射到实现 DEV",
            "简单任务允许只有一个 `DEV-001`",
        ):
            self.assertIn(token, contract)

        self.assertIn("各 `DEV-*` 的来源、最终状态、实际写集", identity)
        self.assertIn("不是独立审批产物", identity)

    def test_build_skill_is_discoverable_for_checklist_only_requests(self):
        build = (WORKFLOW / "dev-build-change/SKILL.md").read_text(
            encoding="utf-8"
        )
        prompt = (
            WORKFLOW / "dev-build-change/agents/openai.yaml"
        ).read_text(encoding="utf-8")

        for token in (
            "根据技术方案、测试清单或完成标准生成/拆分",
            "包括只生成清单、暂不编码",
            "### 清单模式",
            "生成开发清单",
            "只执行 Workflow 1–3",
            "不修改业务代码",
            "不得继续进入第 4 步",
        ):
            self.assertIn(token, build)

        self.assertIn("根据技术方案生成 DEV 开发清单", prompt)
        self.assertIn("用户只要求清单时在拆分后停止且不改代码", prompt)

    def test_build_codeagent_consumes_but_does_not_derive_dev_items(self):
        backend = (REPO / "skills/common/build-codeagent/SKILL.md").read_text(
            encoding="utf-8"
        )
        prompt = (
            REPO / "skills/common/build-codeagent/agents/openai.yaml"
        ).read_text(encoding="utf-8")

        for token in (
            "每个信封只消费一个已定义 `DEV-*`",
            "后端不得自行拆分、合并、改写来源或扩展范围",
            "`development_item`",
            "实际写集超出 DEV 预计边界",
        ):
            self.assertIn(token, backend)
        self.assertIn("每次只消费一个已定义 DEV 项", prompt)
        self.assertIn("不自行拆分或扩展范围", prompt)

    def test_auto_loop_tracks_dev_items_without_new_gate_or_item_budget(self):
        loop = (WORKFLOW / "dev-auto-loop/SKILL.md").read_text(
            encoding="utf-8"
        )
        state = (
            WORKFLOW
            / "dev-auto-loop/references/run-state-and-resume.md"
        ).read_text(encoding="utf-8")

        for token in (
            "`delivery_work`",
            "同一构建 attempt 内执行多个 DEV 不按项额外消费",
            "auto-loop 只把清单摘要",
            "不把 DEV 升级为新审批门禁",
        ):
            self.assertIn(token, loop)
        self.assertIn("DEV 是构建执行状态，不是新的审批身份", state)
        self.assertIn("不增加 repair/transition 计数", state)

    def test_delivery_stages_preserve_development_item_trace(self):
        verify = (WORKFLOW / "dev-verify-change/SKILL.md").read_text(
            encoding="utf-8"
        )
        review = (WORKFLOW / "dev-review-change/SKILL.md").read_text(
            encoding="utf-8"
        )
        finish = (WORKFLOW / "dev-finish-branch/SKILL.md").read_text(
            encoding="utf-8"
        )
        verify_template = (
            WORKFLOW / "dev-verify-change/references/verification-template.md"
        ).read_text(encoding="utf-8")
        review_template = (
            WORKFLOW / "dev-review-change/references/review-template.md"
        ).read_text(encoding="utf-8")

        for text in (verify, review, finish):
            self.assertIn("`DEV-*`", text)
            self.assertIn("实际写集", text)

        self.assertIn("不得用测试通过掩盖未完成开发项", verify)
        self.assertIn("无 DEV 归属的改动或越界写入", review)
        self.assertIn("不得收口为可交付", finish)
        self.assertIn("对应 DEV / 实现位置", verify_template)
        self.assertIn("DEV-001 / 文件:行", review_template)

    def test_test_design_approval_does_not_form_t_early(self):
        loop = (WORKFLOW / "dev-auto-loop/SKILL.md").read_text(
            encoding="utf-8"
        )
        identity = (WORKFLOW / "references/artifact-identity.md").read_text(
            encoding="utf-8"
        )
        review = (WORKFLOW / "dev-review-test-cases/SKILL.md").read_text(
            encoding="utf-8"
        )
        prompt = (
            WORKFLOW / "dev-review-test-cases/agents/openai.yaml"
        ).read_text(encoding="utf-8")

        self.assertIn("只有两项审批均有效后，才定义 `T=(R,S,C,B)`", loop)
        self.assertIn("复核结论绑定 `(R,S,C,B)`", identity)
        self.assertNotIn("T=(R,S,C,B)", review)
        self.assertNotIn("T=(R,S,C,B)", prompt)

    def test_delivery_repair_budget_covers_every_write_return(self):
        loop = (WORKFLOW / "dev-auto-loop/SKILL.md").read_text(
            encoding="utf-8"
        )
        for token in (
            "delivery_repair_limit=3",
            "默认 22",
            "4 + 4 × repair_limit + 2 × evidence_auto_attempt_limit",
            "验证失败、代码评审实现 finding 和收口清理",
            "派发在写动作启动前失败且工作区未变化时不消费 repair",
            "当前 `used < limit`",
            "不递增已经耗尽的 transition 计数",
            "预占 repair 后回 `dev-build-change`",
        ):
            self.assertIn(token, loop)
        self.assertNotIn("delivery_repair_count <= 3", loop)

    def test_auto_loop_uses_attested_reviewer_write_check(self):
        loop = (WORKFLOW / "dev-auto-loop/SKILL.md").read_text(
            encoding="utf-8"
        )
        backend = (REPO / "skills/common/build-codeagent/SKILL.md").read_text(
            encoding="utf-8"
        )
        for text in (loop, backend):
            self.assertIn("checks.write_set_empty", text)
            self.assertIn("changed_files=[]", text)
            self.assertIn("不能作为", text)

    def test_environment_level_reviewer_gap_is_not_retried(self):
        contract = (WORKFLOW / "references/delegation-contract.md").read_text(
            encoding="utf-8"
        )
        loop = (WORKFLOW / "dev-auto-loop/SKILL.md").read_text(
            encoding="utf-8"
        )

        for token in (
            "属于环境级能力缺口",
            "不得创建或重试 reviewer",
            "只有可恢复的单次执行失败",
            "失败原因和环境事实未变化时禁止重试",
            "输入指纹变化时属于新任务而非重试",
        ):
            self.assertIn(token, contract)
        self.assertIn("覆盖完整的写入证明", loop)
        self.assertIn("不得创建或重试 reviewer", loop)
        self.assertIn("输入指纹变化时创建新任务", loop)
        self.assertNotIn(
            "结果无效或 reviewer 不可用属于评审执行失败：允许", loop
        )

    def test_change_review_three_level_severity_is_explicit(self):
        change = (WORKFLOW / "dev-review-change/SKILL.md").read_text(
            encoding="utf-8"
        )
        severity = (
            WORKFLOW
            / "dev-review-change/references/severity-and-complexity.md"
        ).read_text(encoding="utf-8")

        self.assertIn("有意只使用 High / Medium / Low", change)
        self.assertIn("不定义 Blocker", severity)
        self.assertIn("根因类型独立决定", severity)

    def test_requirements_finding_categories_are_enumerated(self):
        review = (WORKFLOW / "requirements-review/SKILL.md").read_text(
            encoding="utf-8"
        )
        template = (
            WORKFLOW / "requirements-review/references/report-template.md"
        ).read_text(encoding="utf-8")
        categories = (
            "目标与范围",
            "用户与场景",
            "业务规则与状态",
            "数据与接口",
            "非功能需求",
            "验收与测试",
            "依赖与发布",
            "材料问题",
        )

        for category in categories:
            self.assertIn(f"`{category}`", review)
            self.assertIn(f"`{category}`", template)
        self.assertIn("一条 finding 只选一个主要类别", template)

    def test_auto_loop_terminal_resume_rules_are_explicit(self):
        loop = (WORKFLOW / "dev-auto-loop/SKILL.md").read_text(
            encoding="utf-8"
        )
        state = (
            WORKFLOW
            / "dev-auto-loop/references/run-state-and-resume.md"
        ).read_text(encoding="utf-8")

        for terminal in (
            "budget_exhausted",
            "blocked_material",
            "blocked_infrastructure",
            "awaiting_human",
            "awaiting_human_risk_decision",
            "no_progress",
            "inconsistent_review",
            "completed",
        ):
            self.assertIn(f"`{terminal}`", state)
        self.assertIn("新的 `task_id`、round", state)
        self.assertIn("不自动授权 commit、push、部署", state)
        self.assertIn("只表示收口为“可交付”", loop)

    def test_direct_and_waived_records_are_traceable(self):
        identity = (WORKFLOW / "references/artifact-identity.md").read_text(
            encoding="utf-8"
        )
        build = (WORKFLOW / "dev-build-change/SKILL.md").read_text(
            encoding="utf-8"
        )
        finish = (WORKFLOW / "dev-finish-branch/SKILL.md").read_text(
            encoding="utf-8"
        )
        for token in (
            "direct-record-v1",
            "waiver-record-v1",
            "{ref,fingerprint}",
            "依赖闭包",
            "solution-review",
            "test-design-review",
            "change-review",
        ):
            self.assertIn(token, identity)
        self.assertIn("尚无 `G/D`", build)
        self.assertIn("构造最小 `direct-record-v1`", build)
        self.assertIn("`solution-review` 必须精确绑定 `(R,S,B)`", finish)
        self.assertIn("`test-design-review` 必须精确绑定 `(R,S,C,B)`", finish)

    def test_formal_approvals_use_immutable_records(self):
        paths = [
            WORKFLOW / "references/artifact-identity.md",
            WORKFLOW / "dev-auto-loop/SKILL.md",
            WORKFLOW / "requirements-review/SKILL.md",
            WORKFLOW / "dev-review-solution/SKILL.md",
            WORKFLOW / "dev-review-test-cases/SKILL.md",
            WORKFLOW / "dev-review-change/SKILL.md",
        ]
        for path in paths:
            text = path.read_text(encoding="utf-8")
            self.assertIn("approval-record-v1", text, path)
            self.assertNotIn("`review.md` 是审批事实源", text, path)

    def test_reviewer_runtime_identity_is_not_a_dispatch_input(self):
        forbidden = "以及编排器从派发运行时记录的 `reviewer_agent_ref`"
        for skill in (
            "requirements-review",
            "dev-review-solution",
            "dev-review-test-cases",
            "dev-review-change",
        ):
            text = (WORKFLOW / skill / "SKILL.md").read_text(encoding="utf-8")
            self.assertNotIn(forbidden, text, skill)

    def test_formal_reviews_use_canonical_delegation_contract(self):
        contract_ref = (
            "/home/joney/projects/ai/agent-tools/skills/dev-workflow/"
            "references/delegation-contract.md"
        )
        canonical_scope = "身份、只读、写入、工具面和结果结构的准入只以该契约为准"
        duplicated_detail = "`reviewer_agent_ref` 不是前置输入，只能在 spawn/stop 后"

        for skill, _ in REVIEWERS.values():
            text = (WORKFLOW / skill / "SKILL.md").read_text(encoding="utf-8")
            self.assertIn(contract_ref, text, skill)
            self.assertIn(canonical_scope, text, skill)
            self.assertNotIn(duplicated_detail, text, skill)

    def test_write_set_empty_requires_attested_evidence(self):
        contract = (WORKFLOW / "references/delegation-contract.md").read_text(
            encoding="utf-8"
        )
        identity = (WORKFLOW / "references/artifact-identity.md").read_text(
            encoding="utf-8"
        )

        for token in (
            "### 写入证明",
            "平台可信的逐 agent 写入事件",
            "repo-snapshot-v1",
            "`git status` 为空",
            "### 已知信任边界",
        ):
            self.assertIn(token, contract)

        for token in (
            "`checks.write_set_empty` 还必须记录证明方法",
            "stop 后、编排器落盘前的快照引用与指纹",
            "监视范围必须覆盖 reviewer 可写的工作区根",
            "范围覆盖无法证明、快照变化或存在无法归因的并发写入",
        ):
            self.assertIn(token, identity)

    def test_change_review_routing_respects_auto_loop_stop_loss(self):
        change_review = (WORKFLOW / "dev-review-change/SKILL.md").read_text(
            encoding="utf-8"
        )
        auto_loop = (WORKFLOW / "dev-auto-loop/SKILL.md").read_text(
            encoding="utf-8"
        )

        for token in (
            "本节只定位根因和建议恢复阶段，不授权自动跳转",
            "`dev-auto-loop`",
            "`awaiting_human`",
            "不得自动跨段回跳",
        ):
            self.assertIn(token, change_review)
        self.assertIn("不自动跨段回跳", auto_loop)

    def test_user_facing_test_checklist_terms_are_consistent(self):
        forbidden = (
            "场景身份",
            "场景版本",
            "场景准入",
            "场景问题",
            "场景映射",
        )
        paths = list(WORKFLOW.rglob("*.md")) + [
            REPO / "skills/common/build-codeagent/SKILL.md"
        ]
        for path in paths:
            text = path.read_text(encoding="utf-8")
            for phrase in forbidden:
                self.assertNotIn(phrase, text, (path, phrase))

    def test_read_only_reviews_allow_natural_language_invocation(self):
        expected = {
            "requirements-review": True,
            "dev-review-solution": True,
            "dev-review-test-cases": True,
            "dev-review-change": True,
            "dev-auto-loop": False,
        }
        for skill, implicit in expected.items():
            text = (WORKFLOW / skill / "agents/openai.yaml").read_text(
                encoding="utf-8"
            )
            value = str(implicit).lower()
            self.assertIn(f"allow_implicit_invocation: {value}", text, skill)


if __name__ == "__main__":
    unittest.main()
