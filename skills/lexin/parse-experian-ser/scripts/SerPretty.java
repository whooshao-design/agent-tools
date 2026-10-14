import java.io.*;
import java.lang.reflect.*;
import java.util.*;

/**
 * Readable renderer for decrypted Experian Strategy Manager .ser files (ExecutableStrategy).
 * Prints: package properties, input/output field dictionary (PDS objects), then the decision flow
 * (segmentations, class/matrix/tree splits, policy rule sets, derived data, strategy tables,
 * value settings, scorecards) with scripts rendered as pseudo code.
 *
 * Build: javac -encoding UTF-8 -d classes SerPretty.java   (no compile-time dependency on the jars)
 * Run:   java -cp da-1.0.0.jar:das-1.0.0.jar:resource-1.0.0.jar:classes SerPretty FILE.ser
 * Reflection only reads private fields; nothing is written back.
 */
public class SerPretty {
    private final StringBuilder out = new StringBuilder();
    private final IdentityHashMap<Object, Integer> shownProc = new IdentityHashMap<>();
    private final IdentityHashMap<Object, Integer> shownRules = new IdentityHashMap<>();

    public static void main(String[] args) throws Exception {
        Object root;
        try (ObjectInputStream in = new ObjectInputStream(new BufferedInputStream(new FileInputStream(args[0])))) {
            root = in.readObject();
        }
        SerPretty p = new SerPretty();
        p.render(root);
        PrintStream ps = new PrintStream(new FileOutputStream(FileDescriptor.out), true, "UTF-8");
        ps.print(p.out);
    }

    // ---------- reflection helpers ----------
    static Object get(Object o, String name) {
        if (o == null) return null;
        for (Class<?> c = o.getClass(); c != null; c = c.getSuperclass()) {
            try {
                Field f = c.getDeclaredField(name);
                f.setAccessible(true);
                return f.get(o);
            } catch (NoSuchFieldException ignore) {
            } catch (IllegalAccessException e) {
                throw new RuntimeException(e);
            }
        }
        return null;
    }

    static String cls(Object o) { return o == null ? "null" : o.getClass().getSimpleName(); }

    static String clean(String s) { return s == null ? null : s.replace("﻿", "").trim(); }

    /** SM values, SMCharArray, strings, numbers -> display text. */
    static String val(Object v) {
        if (v == null) return "null";
        String c = cls(v);
        if (v instanceof String) return clean((String) v);
        if (c.equals("SMCharArray")) {
            char[] d = (char[]) get(v, "data_");
            Integer s = (Integer) get(v, "start_"), l = (Integer) get(v, "length_");
            return d == null ? "" : clean(new String(d, s, Math.min(l, d.length - s)));
        }
        if (c.equals("SMNumber")) return String.valueOf(get(v, "plainString_"));
        if (c.equals("SMHigh")) return "+INF";
        if (c.equals("SMLow")) return "-INF";
        Object ps = get(v, "plainString_");
        if (ps != null) return val(ps);
        Object pc = get(v, "plainCharArray_");
        if (pc != null) return val(pc);
        if (c.equals("SMString") || c.endsWith("String")) {
            Object x = get(v, "value_");
            if (x != null) return val(x);
        }
        return String.valueOf(v);
    }

    static String quoted(Object v) {
        String c = cls(v);
        if (c.equals("SMNumber") || c.equals("SMHigh") || c.equals("SMLow")) return val(v);
        return "\"" + val(v) + "\"";
    }

    static String name(Object o) { return clean(val(get(o, "name_"))); }

    void line(int ind, String s) {
        for (int i = 0; i < ind; i++) out.append("  ");
        out.append(s).append('\n');
    }

    // ---------- top level ----------
    void render(Object strategy) {
        Object props = get(strategy, "runtimeProperties_");
        line(0, "# 包属性");
        line(0, "alias=" + val(get(props, "alias_")) + "  name=" + val(get(props, "fullBusinessObjectiveName_"))
                + "  edition=" + get(props, "editionNumber_") + "  created=" + get(props, "creationDate_")
                + "  smVersion=" + val(get(props, "smSoftwareVersion_")));
        line(0, "");
        line(0, "# 输入/输出对象（PDS）");
        Object ddc = get(strategy, "dataDefinitionContainer_");
        Object maps = get(ddc, "pdsTypeMaps_");
        if (maps != null) {
            for (int i = 0; i < Array.getLength(maps); i++) {
                Map<?, ?> m = (Map<?, ?>) Array.get(maps, i);
                if (m == null) continue;
                for (Map.Entry<?, ?> e : m.entrySet()) {
                    Object def = e.getValue();
                    String[] codes = (String[]) get(def, "characteristicList_");
                    Object chars = get(def, "characteristics_");
                    line(0, "## " + e.getKey() + " (pdsType=" + i + ", lds=" + get(def, "lds_") + ", fields=" + (codes == null ? 0 : codes.length) + ")");
                    for (int k = 0; codes != null && k < codes.length; k++) {
                        Object ch = chars == null ? null : Array.get(chars, k);
                        line(1, codes[k] + " = " + (ch == null ? "?" : charName(ch)) + typeOf(ch));
                    }
                }
            }
        }
        line(0, "");
        Object bo = get(strategy, "businessObjective_");
        line(0, "# 决策流程: " + name(bo));
        proc(get(bo, "businessObjectiveFlow_"), 0);
        line(0, "");
        line(0, "# 用户脚本函数（按函数体去重；参数为 $a/$b 栈变量）");
        for (Map.Entry<String, Integer> f : FUNCS.entrySet()) {
            line(0, "FN" + f.getValue() + ":");
            out.append(f.getKey());
        }
    }

    static String typeOf(Object ch) {
        Object t = get(ch, "type_");
        Object tv = t == null ? null : get(t, "type_");
        String s = tv == null ? "" : (Integer.valueOf(1).equals(tv) ? " [num]" : Integer.valueOf(2).equals(tv) ? " [str]" : " [type" + tv + "]");
        if (cls(ch).equals("RuntimeArrayCharacteristic")) s += "[array size=" + get(ch, "size_") + "]";
        return s;
    }

    static String charName(Object ch) {
        if (ch == null) return "null";
        String c = cls(ch);
        if (c.equals("ArrayIndexRuntimeCharacteristic")) {
            return charName(get(ch, "characteristic_")) + "[" + exprInline(get(ch, "index_")) + "]";
        }
        if (c.equals("ArrayLookupRuntimeCharacteristic")) {
            return charName(get(ch, "characteristic_")) + "[lookup " + exprInline(get(ch, "index_")) + "]";
        }
        String n = name(ch);
        if (c.equals("StackAtomicCharacteristic")) return "$" + n;
        return n == null ? c : n;
    }

    // ---------- processes ----------
    void proc(Object p, int ind) {
        while (p != null) {
            Integer seen = shownProc.get(p);
            if (seen != null) {
                line(ind, "(同上 P" + seen + ": " + procTitle(p) + ")");
                return;
            }
            int id = shownProc.size() + 1;
            shownProc.put(p, id);
            String c = cls(p);
            switch (c) {
                case "GotoProcess":
                case "SegmentedProcess": {
                    line(ind, "P" + id + " [" + (c.equals("GotoProcess") ? "Goto" : "Segmented") + "] " + nz(name(p)));
                    seg(get(p, "segmentation_"), (Object[]) get(p, "processes_"), ind + 1);
                    break;
                }
                case "FlowPerformProcess":
                    line(ind, "P" + id + " [子流程] " + name(p) + " maxIterations=" + get(p, "maxIterations_")
                            + (get(p, "terminationCriteria_") != null ? " until " + exprInline(get(p, "terminationCriteria_")) : ""));
                    proc(get(p, "perform_"), ind + 1);
                    break;
                case "DummyProcess":
                    line(ind, "P" + id + " [空节点] " + nz(name(p)));
                    break;
                case "RuntimePolicyRuleSetFP":
                    policy(p, id, ind);
                    break;
                case "RuntimeDerivedDataFP": {
                    Object dd = get(p, "derivedData_");
                    Object mp = get(get(p, "mappings_"), "nameMapping_");
                    line(ind, "P" + id + " [衍生数据] " + name(dd) + (mp != null ? "  (输出→ " + charName(mp) + ")" : ""));
                    stmt(get(dd, "expression_"), ind + 2);
                    break;
                }
                case "RuntimeStrategyTableEntryFP": {
                    Object e = get(p, "entry_");
                    line(ind, "P" + id + " [策略表项] " + name(e));
                    stmt(get(e, "expression_"), ind + 2);
                    break;
                }
                case "RuntimeValueSettingFP": {
                    Object vs = get(p, "runtimeValueSetting_");
                    line(ind, "P" + id + " [数值设置] " + nz(name(vs)));
                    Object pairs = get(vs, "valuePair_");
                    for (int i = 0; pairs != null && i < Array.getLength(pairs); i++) {
                        Object pr = Array.get(pairs, i);
                        line(ind + 2, vsObj(Array.get(pr, 0)) + " := " + vsObj(Array.get(pr, 1)));
                    }
                    break;
                }
                case "RtScardFP":
                    scorecard(p, id, ind);
                    break;
                case "RuntimeTreeSplitOutcomeFP":
                    line(ind, "=> 树结果: " + name(get(p, "outcome_")) + " (uniqueID=" + get(get(p, "outcome_"), "uniqueID_") + ")");
                    break;
                default:
                    line(ind, "P" + id + " [" + c + "] " + nz(name(p)) + "  (未专门解析，见通用 dump)");
            }
            p = get(p, "next_");
        }
    }

    static String nz(String s) { return s == null ? "" : s; }

    static String procTitle(Object p) {
        String n = name(p);
        if (n != null) return n;
        for (String f : new String[]{"ruleSet_", "derivedData_", "entry_", "runtimeValueSetting_", "scard_", "outcome_"}) {
            Object x = get(p, f);
            if (x != null) return name(x);
        }
        return cls(p);
    }

    String vsObj(Object o) {
        String c = cls(o);
        if (c.equals("RuntimeVSCharacteristic")) return charName(get(o, "characteristic_"));
        if (c.equals("RuntimeVSSMValue")) return quoted(get(o, "value_"));
        return c;
    }

    void policy(Object p, int id, int ind) {
        Object rs = get(p, "ruleSet_");
        Object m = get(p, "mappings_");
        line(ind, "P" + id + " [政策规则集] " + name(rs));
        StringBuilder mp = new StringBuilder();
        for (String f : new String[]{"decisionCategoryMapping_", "decisionTextMapping_", "reasonCodeTableMapping_", "decisionTableMapping_", "policyRuleSetMapping_"}) {
            Object x = get(m, f);
            if (x != null) mp.append(f.replace("Mapping_", "")).append("→").append(charName(x)).append("; ");
        }
        if (mp.length() > 0) line(ind + 1, "输出映射: " + mp);
        seqNode(get(rs, "rootNode_"), ind + 1);
    }

    void seqNode(Object n, int ind) {
        if (n == null) return;
        Object cat = get(n, "category_");
        Object[] rs0 = (Object[]) get(n, "rules_");
        if (rs0 != null && shownRules.containsKey(rs0)) {
            line(ind, "决策类别: " + name(cat) + " (规则同上，见首次出现处)");
        } else if (rs0 != null) {
            shownRules.put(rs0, 1);
        }
        if (rs0 != null && shownRules.get(rs0) == 2) {
            Object t0 = get(n, "true_"), f0 = get(n, "false_");
            if (t0 != null) { line(ind, "命中后(true_):"); seqNode(t0, ind + 1); }
            if (f0 != null) { line(ind, "未命中(false_):"); seqNode(f0, ind + 1); }
            return;
        }
        if (rs0 != null) shownRules.put(rs0, 2);
        line(ind, "决策类别: " + name(cat) + " (priority=" + get(cat, "priority_") + ", text=" + val(get(cat, "decisionText_")) + ")");
        Object[] rules = (Object[]) get(n, "rules_");
        for (int i = 0; rules != null && i < rules.length; i++) {
            Object r = rules[i];
            line(ind + 1, "规则 " + (i + 1) + ": " + name(r) + "  原因码=" + val(get(r, "reasonCode_"))
                    + (Boolean.FALSE.equals(get(r, "evaluationMode_")) ? "  [evaluationMode=false]" : ""));
            line(ind + 3, "IF " + exprInline(get(r, "condition_")));
        }
        Object t = get(n, "true_"), f = get(n, "false_");
        if (t != null) { line(ind, "命中后(true_):"); seqNode(t, ind + 1); }
        if (f != null) { line(ind, "未命中(false_):"); seqNode(f, ind + 1); }
    }

    void scorecard(Object p, int id, int ind) {
        Object sc = get(p, "scard_");
        Object m = get(p, "mappings_");
        line(ind, "P" + id + " [评分卡] " + name(sc) + "  得分→ " + charName(get(m, "scoreMapping_"))
                + (get(m, "idMapping_") != null ? "  id→ " + charName(get(m, "idMapping_")) : ""));
        Object ix = get(sc, "iXform_");
        if (ix != null && get(ix, "convertedWeight_") != null) line(ind + 1, "初始分(iXform)=" + val(get(ix, "convertedWeight_")));
        Object[] els = (Object[]) get(sc, "elements_");
        for (int i = 0; els != null && i < els.length; i++) {
            Object e = els[i];
            Object split = get(e, "seg_");
            Object[] rules = (Object[]) get(e, "rules_");
            line(ind + 1, "特征 " + (i + 1) + ": " + nz(name(split)) + "  变量=" + charName(get(split, "characteristic_")));
            for (String[] b : bins(split)) {
                int oi = Integer.parseInt(b[0]);
                Object r = rules != null && oi < rules.length ? rules[oi] : null;
                line(ind + 3, b[1] + "  => " + b[2] + "  分值=" + (r == null ? "?" : val(get(r, "convertedWeight_")))
                        + (r != null && !val(get(r, "rc_")).isEmpty() ? " rc=" + val(get(r, "rc_")) : ""));
            }
        }
    }

    /** For a class split: list of {outcomeIndex, condition, outcomeName}. */
    List<String[]> bins(Object split) {
        List<String[]> res = new ArrayList<>();
        Object cs = get(split, "cs_");
        Object[] def = (Object[]) get(cs, "csDef_");
        for (int i = 0; def != null && i < def.length; i++) {
            Object el = def[i];
            Object lo = get(el, "low_"), hi = get(el, "high_");
            Object oc = get(el, "outcome_");
            String cond = hi == null ? "= " + quoted(lo) : "[" + val(lo) + ", " + val(hi) + "]";
            res.add(new String[]{String.valueOf(get(oc, "index_")), cond, name(oc)});
        }
        Object others = get(cs, "others_");
        if (others != null) res.add(new String[]{String.valueOf(get(others, "index_")), "其他", name(others)});
        return res;
    }

    // ---------- segmentation ----------
    void seg(Object s, Object[] procs, int ind) {
        if (s == null) return;
        String c = cls(s);
        if (c.equals("SingleOutcomeSegmentation")) {
            Object oc = get(s, "outcome_");
            int idx = (Integer) get(oc, "index_");
            line(ind, "-> 节点[" + idx + "] " + nz(name(oc)));
            if (procs != null && idx < procs.length) proc(procs[idx], ind + 1);
            return;
        }
        if (c.equals("AggregateSegmentation")) {
            Object split = get(s, "segmentation_");
            Object[] children = (Object[]) get(s, "children_");
            String sc = cls(split);
            if (sc.equals("RuntimeClassSplit")) {
                line(ind, "分段细分: " + nz(name(split)) + "  变量=" + charName(get(split, "characteristic_")));
                for (String[] b : bins(split)) {
                    line(ind + 1, "当 " + b[1] + " (" + b[2] + "):");
                    seg(children[Integer.parseInt(b[0])], procs, ind + 2);
                }
            } else if (sc.equals("RuntimeMatrixSplit")) {
                matrix(split, children, procs, ind);
            } else if (sc.equals("RuntimeTreeSplit")) {
                line(ind, "决策树: " + nz(name(split)));
                line(ind + 1, "树内部分支:");
                proc(get(split, "segmentation_"), ind + 2);
                Object outs = get(split, "outcomes_");
                for (int i = 0; outs != null && i < Array.getLength(outs); i++) {
                    Object o = Array.get(outs, i);
                    line(ind + 1, "树结果 " + name(o) + " (uniqueID=" + get(o, "uniqueID_") + "):");
                    if (i < children.length) seg(children[i], procs, ind + 2);
                }
                Object om = get(split, "outcomesMap_");
                if (outs == null && om instanceof Map) {
                    for (Map.Entry<?, ?> en : new TreeMap<Object, Object>((Map<?, ?>) om).entrySet()) {
                        Object o = en.getValue();
                        Object idx = get(o, "index_");
                        line(ind + 1, "树结果 " + name(o) + " (uniqueID=" + en.getKey() + "):");
                        if (idx instanceof Integer && (Integer) idx < children.length) seg(children[(Integer) idx], procs, ind + 2);
                    }
                }
            } else {
                line(ind, "细分[" + sc + "] " + nz(name(split)) + " (未专门解析)");
                for (int i = 0; i < children.length; i++) {
                    line(ind + 1, "结果 " + i + ":");
                    seg(children[i], procs, ind + 2);
                }
            }
            return;
        }
        line(ind, "细分[" + c + "] (未专门解析)");
    }

    void matrix(Object m, Object[] children, Object[] procs, int ind) {
        Object x = get(m, "xSeg_"), y = get(m, "ySeg_");
        line(ind, "矩阵细分: " + nz(name(m)));
        List<String[]> xb = bins(x), yb = bins(y);
        line(ind + 1, "行变量=" + charName(get(x, "characteristic_")) + " (" + nz(name(x)) + ")");
        line(ind + 1, "列变量=" + charName(get(y, "characteristic_")) + " (" + nz(name(y)) + ")");
        Object[] grid = (Object[]) get(m, "grid_");
        StringBuilder hdr = new StringBuilder("行\\列");
        for (String[] b : yb) hdr.append(" | ").append(b[1]);
        line(ind + 1, hdr.toString());
        for (String[] rb : xb) {
            int ri = Integer.parseInt(rb[0]);
            StringBuilder row = new StringBuilder(rb[1]);
            Object[] r = ri < grid.length ? (Object[]) grid[ri] : null;
            for (String[] cb : yb) {
                int ci = Integer.parseInt(cb[0]);
                row.append(" | ").append(r == null || ci >= r.length ? "?" : name(r[ci]));
            }
            line(ind + 2, row.toString());
        }
        Set<Integer> done = new TreeSet<>();
        for (Object r : grid) for (Object o : (Object[]) r) if (o != null) done.add((Integer) get(o, "index_"));
        for (int idx : done) {
            String n = null;
            for (Object r : grid) for (Object o : (Object[]) r) if (o != null && (Integer) get(o, "index_") == idx) n = name(o);
            line(ind + 1, "结果 " + n + ":");
            if (idx < children.length) seg(children[idx], procs, ind + 2);
        }
    }

    // ---------- scripts ----------
    static final Map<String, String> CMP = new HashMap<>();
    static {
        CMP.put("RuntimeEqualToExpression", "=");
        CMP.put("RuntimeNotEqualToExpression", "<>");
        CMP.put("RuntimeGreaterThanExpression", ">");
        CMP.put("RuntimeGreaterThanOrEqualToExpression", ">=");
        CMP.put("RuntimeLessThanExpression", "<");
        CMP.put("RuntimeLessThanOrEqualToExpression", "<=");
    }

    void stmt(Object e, int ind) {
        if (e == null) return;
        String c = cls(e);
        switch (c) {
            case "RuntimeDoExpression":
                for (Object x : (Object[]) get(e, "expressions_")) stmt(x, ind);
                return;
            case "RuntimeIfExpression": {
                line(ind, "IF " + exprInline(get(e, "condition_")) + " THEN");
                stmt(get(e, "body_"), ind + 1);
                Object el = get(e, "else_");
                while (el != null && cls(el).equals("RuntimeIfExpression")) {
                    line(ind, "ELSE IF " + exprInline(get(el, "condition_")) + " THEN");
                    stmt(get(el, "body_"), ind + 1);
                    el = get(el, "else_");
                }
                if (el != null) {
                    line(ind, "ELSE");
                    stmt(el, ind + 1);
                }
                line(ind, "END IF");
                return;
            }
            case "RuntimeWhileExpression":
            case "RuntimeRepeatExpression":
                line(ind, (c.contains("While") ? "WHILE " : "REPEAT UNTIL ") + exprInline(get(e, "condition_")) + "  (limit=" + exprInline(get(e, "limit_")) + ")");
                stmt(get(e, "expression_"), ind + 1);
                line(ind, "END");
                return;
            case "RuntimeAssignExpression":
                line(ind, charName(get(e, "variable_")) + " := " + exprInline(get(e, "value_")));
                return;
            case "RuntimeReturnExpression":
                line(ind, "RETURN " + exprInline(get(e, "expression_")));
                return;
            default:
                line(ind, exprInline(e));
        }
    }

    static String exprInline(Object e) {
        if (e == null) return "null";
        if (e instanceof Number || e instanceof String) return String.valueOf(e);
        String c = cls(e);
        if (CMP.containsKey(c)) return exprInline(get(e, "expression_")) + " " + CMP.get(c) + " " + exprInline(get(e, "comparison_"));
        switch (c) {
            case "RuntimeVariableExpression":
                return charName(get(e, "characteristic_"));
            case "RuntimeConstantExpression":
                return quoted(get(e, "value_"));
            case "RuntimeANDExpression":
            case "RuntimeORExpression": {
                StringJoiner j = new StringJoiner(c.contains("AND") ? " AND " : " OR ", "(", ")");
                for (Object x : (Object[]) get(e, "expressions_")) j.add(exprInline(x));
                return j.toString();
            }
            case "RuntimeAdditionExpression": {
                Object[] xs = (Object[]) get(e, "expressions_");
                boolean[] sub = (boolean[]) get(e, "subtract_");
                StringBuilder b = new StringBuilder("(");
                String k = val(get(e, "constantValue_"));
                boolean first = true;
                if (!isZero(k)) { b.append(k); first = false; }
                for (int i = 0; i < xs.length; i++) {
                    boolean s = sub != null && sub[i];
                    if (first) b.append(s ? "-" : "");
                    else b.append(s ? " - " : " + ");
                    b.append(exprInline(xs[i]));
                    first = false;
                }
                return b.append(")").toString();
            }
            case "RuntimeMultiplicationExpression": {
                Object[] xs = (Object[]) get(e, "expressions_");
                boolean[] div = (boolean[]) get(e, "divide_");
                StringBuilder b = new StringBuilder("(");
                String k = val(get(e, "constantValue_"));
                boolean first = true;
                if (!k.equals("1")) { b.append(k); first = false; }
                for (int i = 0; i < xs.length; i++) {
                    boolean d = div != null && div[i];
                    if (first) b.append(d ? "1 / " : "");
                    else b.append(d ? " / " : " * ");
                    b.append(exprInline(xs[i]));
                    first = false;
                }
                return b.append(")").toString();
            }
            case "RuntimeNegateExpression":
                return "-" + exprInline(get(e, "expression_"));
            case "RuntimeIfExpression":
                return "IF(" + exprInline(get(e, "condition_")) + ", " + exprInline(get(e, "body_")) + ", " + exprInline(get(e, "else_")) + ")";
            case "RuntimeAssignExpression":
                return charName(get(e, "variable_")) + " := " + exprInline(get(e, "value_"));
            case "RuntimeReturnExpression":
                return "RETURN " + exprInline(get(e, "expression_"));
            case "RuntimeDoExpression": {
                StringJoiner j = new StringJoiner("; ", "{", "}");
                for (Object x : (Object[]) get(e, "expressions_")) j.add(exprInline(x));
                return j.toString();
            }
            case "RuntimeUserScriptFunctionExpression": {
                StringJoiner j = new StringJoiner(", ", "(", ")");
                Object ps = get(e, "parameters_");
                for (int i = 0; ps != null && i < Array.getLength(ps); i++) j.add(exprInline(Array.get(ps, i)));
                Object body = get(e, "expression_");
                SerPretty tmp = new SerPretty();
                tmp.stmt(body, 1);
                String text = tmp.out.toString();
                Integer fid = FUNCS.get(text);
                if (fid == null) { fid = FUNCS.size() + 1; FUNCS.put(text, fid); }
                return "FN" + fid + j;
            }
            case "RuntimeSubstringExpression":
                return "SUBSTR(" + exprInline(get(e, "expression_")) + ", " + exprInline(get(e, "offset_")) + ", " + exprInline(get(e, "length_")) + ")";
            case "RuntimeFindExpression":
                return "FIND(" + exprInline(get(e, "expression_")) + " IN " + exprInline(get(e, "variable_")) + ")";
            case "RuntimePowerExpression":
                return "POWER(" + exprInline(get(e, "expression_")) + ", " + exprInline(get(e, "power_")) + ")";
            case "RuntimeRoundUpExpression":
            case "RuntimeRoundDownExpression":
                return (c.contains("Up") ? "ROUNDUP(" : "ROUNDDOWN(") + exprInline(get(e, "expression_")) + ", " + exprInline(get(e, "round_")) + ")";
            case "RuntimeMonthsExpression":
                return "MONTHS(" + exprInline(get(e, "firstDate_")) + ", " + exprInline(get(e, "secondDate_")) + ")";
            case "RuntimeToNumericExpression":
            case "RuntimeToStringExpression":
            case "RuntimeToDateExpression":
            case "RuntimeSystemDateExpression":
                return c.replace("Runtime", "").replace("Expression", "").toUpperCase() + "(" + exprInline(get(e, "expression_")) + ")";
            default:
                if (c.endsWith("Characteristic")) return charName(e);
                if (get(e, "plainString_") != null || c.startsWith("SM")) return quoted(e);
                return c + "{?}";
        }
    }

    static final LinkedHashMap<String, Integer> FUNCS = new LinkedHashMap<>();  // body text -> id

    static boolean isZero(String k) {
        try { return Double.parseDouble(k) == 0d; } catch (Exception ex) { return false; }
    }
}
