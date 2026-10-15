import java.io.*;
import java.lang.reflect.*;
import java.util.*;

/**
 * Spike: decrypted Experian Strategy Manager .ser (ExecutableStrategy) -> XML in the shape read by the
 * Mihawk migration tool (server_hawk_decision_manage transfer/SerXmlElement, SerCommonElement,
 * ProcessFlowParse). Scripts are re-emitted as SM source text (comments are not recoverable).
 *
 * Covered: GotoProcess / SegmentedProcess with single-outcome or class-split segmentation, derived data,
 * policy rule sets, class sets, PDS/working-storage characteristics, user script functions that match a
 * known body (Min函数, Max函数, 字符串包含判断函数). Anything else is reported on stderr as WARN and
 * left as an XML comment / UNSUPPORTED marker, so the consumer fails loudly instead of migrating silently.
 *
 * Build: javac -encoding UTF-8 -d classes SerToXml.java   (no compile-time dependency on the jars)
 * Run:   java -cp da-1.0.0.jar:das-1.0.0.jar:resource-1.0.0.jar:classes SerToXml FILE.ser [SUFFIX] > FILE.xml
 * SUFFIX (e.g. _FQLBYJ) is appended to every component name (class set, derived data, policy rule, policy rule
 * set) and to all references to them, so the migration tool creates new Mihawk components instead of editing
 * existing same-name ones. Note it also stops Hippo condition_mapping keys (name_code) from matching.
 * Reflection only reads private fields; nothing is written back.
 */
public class SerToXml {
    private final List<String> warnings = new ArrayList<>();
    private final LinkedHashMap<String, Object> refChars = new LinkedHashMap<>();
    private final LinkedHashMap<String, String> classSets = new LinkedHashMap<>();
    private final LinkedHashMap<String, String> derived = new LinkedHashMap<>();
    private final LinkedHashMap<String, String[]> rules = new LinkedHashMap<>();   // name -> {script, code, evalMode}
    private final LinkedHashMap<String, String> ruleSets = new LinkedHashMap<>();
    private final IdentityHashMap<Object, String> procNames = new IdentityHashMap<>();
    private final Set<String> usedProcNames = new HashSet<>();
    private final Set<Object> emitted = Collections.newSetFromMap(new IdentityHashMap<>());
    private final StringBuilder flows = new StringBuilder();
    private boolean inFunction;
    private final String suffix;

    SerToXml(String suffix) { this.suffix = suffix == null ? "" : suffix; }

    /** Component name as emitted: SM name plus the optional suffix. */
    String comp(String n) { return n + suffix; }

    /** Known user script function bodies (whitespace removed) -> name in SerDefined.usrDefinedMethodMap. */
    static final Map<String, String> KNOWN_FUNCS = new LinkedHashMap<>();
    static {
        KNOWN_FUNCS.put("IF$a<=$bTHENRETURN$aELSERETURN$bENDIF", "Min函数");
        KNOWN_FUNCS.put("IF$a<=$bTHENRETURN$bELSERETURN$aENDIF", "Max函数");
        KNOWN_FUNCS.put("IF($a=\"\"OR$b=\"\")THENRETURN-1ENDIF'临时变量.自定义函数用整数变量'=0'临时变量.自定义函数用整数变量1'=1"
                + "'临时变量.自定义函数用整数变量2'=0WHILESUBSTRING($b,'临时变量.自定义函数用整数变量1',1)<>\"\"LIMIT200"
                + "'临时变量.自定义函数用整数变量1'=(1+'临时变量.自定义函数用整数变量1')END_WHILE"
                + "'临时变量.自定义函数用整数变量1'=(-1+'临时变量.自定义函数用整数变量1')WHILE'临时变量.自定义函数用整数变量'<=200LIMIT200"
                + "'临时变量.自定义函数用整数变量'=(1+'临时变量.自定义函数用整数变量')IFSUBSTRING($a,'临时变量.自定义函数用整数变量',"
                + "'临时变量.自定义函数用整数变量1')=$bTHEN'临时变量.自定义函数用整数变量2'=(1+'临时变量.自定义函数用整数变量2')ENDIF"
                + "END_WHILERETURN'临时变量.自定义函数用整数变量2'", "字符串包含判断函数");
    }

    public static void main(String[] args) throws Exception {
        Object root;
        try (ObjectInputStream in = new ObjectInputStream(new BufferedInputStream(new FileInputStream(args[0])))) {
            root = in.readObject();
        }
        SerToXml g = new SerToXml(args.length > 1 ? args[1] : null);
        String xml = g.render(root, new File(args[0]).getName());
        PrintStream ps = new PrintStream(new FileOutputStream(FileDescriptor.out), true, "UTF-8");
        ps.print(xml);
        PrintStream err = new PrintStream(new FileOutputStream(FileDescriptor.err), true, "UTF-8");
        for (String w : g.warnings) err.println("WARN " + w);
        err.println("summary: process_flow=" + g.procNames.size() + " class_set=" + g.classSets.size()
                + " derived_data=" + g.derived.size() + " policy_rule=" + g.rules.size()
                + " policy_rule_set=" + g.ruleSets.size() + " warnings=" + g.warnings.size());
    }

    // ---------- reflection helpers (same conventions as SerPretty) ----------
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
        Object ps = get(v, "plainString_");
        if (ps != null) return val(ps);
        Object pc = get(v, "plainCharArray_");
        if (pc != null) return val(pc);
        Object x = get(v, "value_");
        if (x != null) return val(x);
        return String.valueOf(v);
    }

    static boolean isNumber(Object v) { return cls(v).equals("SMNumber"); }

    static String name(Object o) { return clean(val(get(o, "name_"))); }

    static String esc(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;");
    }

    void warn(String s) { warnings.add(s); }

    static String pad(int n) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < n; i++) b.append("  ");
        return b.toString();
    }

    // ---------- top level ----------
    String render(Object strategy, String source) {
        Object props = get(strategy, "runtimeProperties_");
        Object bo = get(strategy, "businessObjective_");
        String flowRefXml = flowRef(get(bo, "businessObjectiveFlow_"), 7);

        StringBuilder x = new StringBuilder();
        x.append("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
        x.append("<!-- generated by SerToXml from ").append(esc(source)).append(": alias=").append(esc(val(get(props, "alias_"))))
                .append(" edition=").append(get(props, "editionNumber_")).append(" created=").append(esc(String.valueOf(get(props, "creationDate_"))))
                .append(". Scripts are rebuilt from compiled expression trees; original comments, layout and obj_info are not recoverable. -->\n");
        x.append("<sm_export>\n");
        dataUniverse(strategy, x);
        x.append("  <client_system_SDS>\n    <business_area name=\"").append(esc(name(bo))).append("\">\n");
        nativeDataUniverse(x);
        x.append("      <component>\n");
        x.append("        <component_lib type=\"business_objective\">\n");
        x.append("          <business_objective name=\"").append(esc(name(bo))).append("\">\n");
        x.append("            <alias>").append(esc(val(get(props, "alias_")))).append("</alias>\n");
        x.append("            <business_objective_flow>\n              <flow>\n").append(flows).append("              </flow>\n");
        x.append("              <flow_structure>\n").append(flowRefXml).append("              </flow_structure>\n");
        x.append("            </business_objective_flow>\n          </business_objective>\n        </component_lib>\n");
        lib(x, "class_set", classSets.values());
        List<String> dd = new ArrayList<>();
        for (Map.Entry<String, String> e : derived.entrySet()) {
            dd.add("<derived_data name=\"" + esc(e.getKey()) + "\">\n" + pad(6) + "<script>" + esc(e.getValue()) + "</script>\n" + pad(5) + "</derived_data>");
        }
        lib(x, "derived_data", dd);
        List<String> pr = new ArrayList<>();
        for (Map.Entry<String, String[]> e : rules.entrySet()) {
            String[] r = e.getValue();
            pr.add("<policy_rule name=\"" + esc(e.getKey()) + "\">\n"
                    + pad(6) + "<policy_rule_script>" + esc(r[0]) + "</policy_rule_script>\n"
                    + pad(6) + "<policy_rule_reason_code_name>" + esc(r[1]) + "</policy_rule_reason_code_name>\n"
                    + pad(6) + "<evaluation_mode>" + r[2] + "</evaluation_mode>\n" + pad(5) + "</policy_rule>");
        }
        lib(x, "policy_rule", pr);
        lib(x, "policy_rule_set", ruleSets.values());
        x.append("      </component>\n    </business_area>\n  </client_system_SDS>\n</sm_export>\n");
        return x.toString();
    }

    void lib(StringBuilder x, String type, Collection<String> items) {
        if (items.isEmpty()) return;
        x.append("        <component_lib type=\"").append(type).append("\">\n");
        for (String s : items) x.append(pad(5)).append(s).append('\n');
        x.append("        </component_lib>\n");
    }

    // ---------- data universe ----------
    static String charXml(String nameAttr, Object ch, int ind) {
        Object t = get(get(ch, "type_"), "type_");
        int dt = t instanceof Integer ? (Integer) t : 0;
        Object prec = get(get(ch, "logDef_"), "numberDigitsAfterDecimalPlace_");
        Object size = cls(ch).equals("RuntimeArrayCharacteristic") ? get(ch, "size_") : 0;
        return pad(ind) + "<characteristic name=\"" + esc(nameAttr) + "\"><data_type>" + dt + "</data_type><precision>"
                + (dt == 1 && prec != null ? prec : 0) + "</precision><array_size>" + size + "</array_size></characteristic>\n";
    }

    static String prefix(String charName) {
        int i = charName.indexOf('.');
        return i < 0 ? "" : charName.substring(0, i);
    }

    void dataUniverse(Object strategy, StringBuilder x) {
        LinkedHashMap<String, StringBuilder> sources = new LinkedHashMap<>();
        LinkedHashMap<String, StringBuilder> layouts = new LinkedHashMap<>();
        Set<String> inPds = new HashSet<>();
        Object maps = get(get(strategy, "dataDefinitionContainer_"), "pdsTypeMaps_");
        for (int i = 0; maps != null && i < Array.getLength(maps); i++) {
            Map<?, ?> m = (Map<?, ?>) Array.get(maps, i);
            if (m == null) continue;
            for (Map.Entry<?, ?> e : new TreeMap<Object, Object>(m).entrySet()) {
                String[] codes = (String[]) get(e.getValue(), "characteristicList_");
                Object chars = get(e.getValue(), "characteristics_");
                for (int k = 0; codes != null && k < codes.length; k++) {
                    Object ch = Array.get(chars, k);
                    String n = name(ch);
                    String ds = prefix(n), rest = n.substring(ds.length() + 1);
                    inPds.add(n);
                    sources.computeIfAbsent(ds, z -> new StringBuilder()).append(charXml(rest, ch, 3));
                    layouts.computeIfAbsent(ds, z -> new StringBuilder()).append(pad(4)).append("<layout characteristic=\"").append(esc(rest))
                            .append("\"><property name=\"External Name\">").append(esc(codes[k])).append("</property></layout>\n");
                }
            }
        }
        for (Map.Entry<String, Object> e : refChars.entrySet()) {
            String n = e.getKey(), ds = prefix(n);
            if (inPds.contains(n) || !isPublic(ds)) continue;
            warn("public characteristic " + n + " is used but not in any PDS object: emitted without External Name (the consumer drops it)");
            sources.computeIfAbsent(ds, z -> new StringBuilder()).append(charXml(n.substring(ds.length() + 1), e.getValue(), 3));
        }
        x.append("  <data_universe>\n");
        for (Map.Entry<String, StringBuilder> e : sources.entrySet()) {
            x.append("    <data_source name=\"").append(esc(e.getKey())).append("\">\n").append(e.getValue()).append("    </data_source>\n");
        }
        x.append("    <data_universe_SDS>\n");
        for (Map.Entry<String, StringBuilder> e : layouts.entrySet()) {
            x.append("      <data_source_definition logical_data_source=\"").append(esc(e.getKey())).append("\">\n")
                    .append(e.getValue()).append("      </data_source_definition>\n");
        }
        x.append("    </data_universe_SDS>\n  </data_universe>\n");
    }

    static boolean isPublic(String ds) { return ds.equals("学生审批输入") || ds.equals("学生审批输出"); }

    void nativeDataUniverse(StringBuilder x) {
        LinkedHashMap<String, StringBuilder> sources = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : refChars.entrySet()) {
            String ds = prefix(e.getKey());
            if (isPublic(ds)) continue;
            sources.computeIfAbsent(ds, z -> new StringBuilder()).append(charXml(e.getKey(), e.getValue(), 5));
        }
        x.append("      <data_universe>\n");
        for (Map.Entry<String, StringBuilder> e : sources.entrySet()) {
            x.append("        <data_source name=\"").append(esc(e.getKey())).append("\">\n").append(e.getValue()).append("        </data_source>\n");
        }
        x.append("      </data_universe>\n");
    }

    // ---------- process flow ----------
    String procName(Object p) {
        String n = procNames.get(p);
        if (n != null) return n;
        n = name(p);
        if (n == null || n.isEmpty()) n = cls(p);
        String base = n;
        for (int i = 2; usedProcNames.contains(n); i++) n = base + "_" + i;
        if (!n.equals(base)) warn("duplicate process name " + base + " renamed to " + n);
        usedProcNames.add(n);
        procNames.put(p, n);
        return n;
    }

    /** Emits process_flow for p (once) and returns the flow_ref subtree for the chain starting at p. */
    String flowRef(Object p, int ind) {
        while (p != null && cls(p).equals("DummyProcess")) p = get(p, "next_");
        if (p == null) return "";
        boolean first = emitted.add(p);
        String n = procName(p);
        String c = cls(p);
        List<Object> children = new ArrayList<>();
        if (c.equals("GotoProcess")) {
            Object[] procs = (Object[]) get(p, "processes_");
            if (first) {
                flows.append(pad(8)).append("<process_flow name=\"").append(esc(n)).append("\" type=\"goto\">\n");
                flows.append(split(get(p, "segmentation_"), procs, true, 9));
                flows.append(pad(9)).append("<functional_process func_obj=\"").append(esc(n)).append("\" type=\"goto\"/>\n");
                flows.append(pad(8)).append("</process_flow>\n");
            }
            for (int i = 0; procs != null && i < procs.length; i++) {
                Object t = procs[i];
                while (t != null && cls(t).equals("DummyProcess")) t = get(t, "next_");
                if (t != null && !children.contains(t)) children.add(t);
            }
            if (get(p, "next_") != null) warn("GotoProcess " + n + " has next_; ignored after goto");
        } else if (c.equals("SegmentedProcess")) {
            if (first) {
                Object seg = get(p, "segmentation_");
                Object[] procs = (Object[]) get(p, "processes_");
                flows.append(pad(8)).append("<process_flow name=\"").append(esc(n)).append("\" type=\"complex\">\n");
                if (cls(seg).equals("SingleOutcomeSegmentation")) {
                    int idx = (Integer) get(get(seg, "outcome_"), "index_");
                    Object fp = procs != null && idx < procs.length ? procs[idx] : null;
                    if (fp == null) {
                        warn("SegmentedProcess " + n + " has an empty leaf; emitted as doNothing script");
                        flows.append(pad(9)).append("<process_object name=\"").append(esc(n)).append("\" type=\"process\">\n")
                                .append(pad(10)).append("<functional_process doNothing=\"true\" func_obj=\"").append(esc(n)).append("\" type=\"deriveddata\"/>\n")
                                .append(pad(9)).append("</process_object>\n");
                    } else {
                        flows.append(fpChain(fp, n, 9));
                    }
                } else {
                    flows.append(split(seg, procs, false, 9));
                }
                flows.append(pad(8)).append("</process_flow>\n");
            }
            if (get(p, "next_") != null) children.add(get(p, "next_"));
        } else {
            warn("process " + n + " [" + c + "] not supported");
            flows.append(pad(8)).append("<!-- UNSUPPORTED process ").append(esc(n)).append(" [").append(c).append("] -->\n");
        }
        StringBuilder b = new StringBuilder();
        b.append(pad(ind)).append("<flow_ref name=\"").append(esc(n)).append("\"");
        StringBuilder kids = new StringBuilder();
        for (Object ch : children) kids.append(flowRef(ch, ind + 1));
        if (kids.length() == 0) return b.append("/>\n").toString();
        return b.append(">\n").append(kids).append(pad(ind)).append("</flow_ref>\n").toString();
    }

    /** Chain of functional processes (fp.next_) as nested process_object type=process. */
    String fpChain(Object fp, String ownerName, int ind) {
        if (fp == null) return "";
        String c = cls(fp);
        String type, obj;
        switch (c) {
            case "RuntimeDerivedDataFP": {
                Object dd = get(fp, "derivedData_");
                obj = register(derived, comp(name(dd)), script(get(dd, "expression_")), "derived_data");
                type = "deriveddata";
                if (get(get(fp, "mappings_"), "nameMapping_") != null) warn("derived data " + obj + " has nameMapping_; not represented");
                break;
            }
            case "RuntimePolicyRuleSetFP":
                obj = policySet(fp);
                type = "policyruleset";
                break;
            default:
                warn("functional process [" + c + "] under " + ownerName + " not supported");
                return pad(ind) + "<!-- UNSUPPORTED functional process [" + c + "] -->\n";
        }
        StringBuilder b = new StringBuilder();
        b.append(pad(ind)).append("<process_object name=\"").append(esc(obj)).append("\" type=\"process\">\n");
        b.append(pad(ind + 1)).append("<functional_process func_obj=\"").append(esc(obj)).append("\" type=\"").append(type).append("\"/>\n");
        b.append(fpChain(get(fp, "next_"), ownerName, ind + 1));
        b.append(pad(ind)).append("</process_object>\n");
        return b.toString();
    }

    String register(Map<String, String> m, String n, String body, String what) {
        String k = n;
        for (int i = 2; m.containsKey(k) && !m.get(k).equals(body); i++) k = n + "_" + i;
        if (!k.equals(n)) warn(what + " name " + n + " reused with different content; renamed to " + k);
        m.put(k, body);
        return k;
    }

    /** classsetsplit process_object for an AggregateSegmentation(RuntimeClassSplit). */
    String split(Object seg, Object[] procs, boolean isGoto, int ind) {
        if (!cls(seg).equals("AggregateSegmentation") || !cls(get(seg, "segmentation_")).equals("RuntimeClassSplit")) {
            warn("segmentation [" + cls(seg) + "/" + cls(get(seg, "segmentation_")) + "] not supported");
            return pad(ind) + "<!-- UNSUPPORTED segmentation " + cls(seg) + " -->\n";
        }
        Object sp = get(seg, "segmentation_");
        Object[] kids = (Object[]) get(seg, "children_");
        String csName = comp(name(sp));
        Object lc = get(sp, "characteristic_");
        charRef(lc);
        String linked = name(lc);
        List<String[]> bins = classSet(csName, linked, get(sp, "cs_"));
        StringBuilder b = new StringBuilder();
        b.append(pad(ind)).append("<process_object name=\"").append(esc(linked + ":" + csName)).append("\" type=\"classsetsplit\">\n");
        for (String[] bin : bins) {   // {outcomeIndex, outcomeName}
            Object child = kids[Integer.parseInt(bin[0])];
            b.append(pad(ind + 1)).append("<xconnector>\n");
            if (cls(child).equals("SingleOutcomeSegmentation")) {
                Object oc = get(child, "outcome_");
                int idx = (Integer) get(oc, "index_");
                Object target = procs != null && idx < procs.length ? procs[idx] : null;
                b.append(pad(ind + 2)).append("<process_object name=\"").append(esc(name(oc))).append("\" type=\"outcome\">\n");
                if (isGoto) {
                    while (target != null && cls(target).equals("DummyProcess")) target = get(target, "next_");
                    b.append(pad(ind + 3)).append("<process_object name=\"\" type=\"goto\">\n");
                    if (target != null) {
                        String t = procName(target);
                        b.append(pad(ind + 4)).append("<process_object name=\"").append(esc(t)).append("\" type=\"complex\">\n")
                                .append(pad(ind + 5)).append("<functional_process func_obj=\"").append(esc(t)).append("\" type=\"complex\"/>\n")
                                .append(pad(ind + 4)).append("</process_object>\n");
                    }
                    b.append(pad(ind + 4)).append("<functional_process type=\"goto\"/>\n").append(pad(ind + 3)).append("</process_object>\n");
                } else if (target != null) {
                    b.append(fpChain(target, csName, ind + 3));
                }
                b.append(pad(ind + 2)).append("</process_object>\n");
            } else {
                b.append(split(child, procs, isGoto, ind + 2));
            }
            b.append(pad(ind + 2)).append("<outcome name=\"").append(esc(bin[1])).append("\"/>\n");
            b.append(pad(ind + 1)).append("</xconnector>\n");
        }
        b.append(pad(ind + 1)).append("<functional_process func_obj=\"").append(esc(linked + "." + csName)).append("\" type=\"classsetmapping\"/>\n");
        b.append(pad(ind)).append("</process_object>\n");
        return b.toString();
    }

    /** Registers the class_set component; returns bins {outcomeIndex, outcomeName} in definition order, others last. */
    List<String[]> classSet(String csName, String linked, Object cs) {
        LinkedHashMap<String, List<String>> ranges = new LinkedHashMap<>();
        LinkedHashMap<String, String> outIdx = new LinkedHashMap<>();
        Object[] def = (Object[]) get(cs, "csDef_");
        for (int i = 0; def != null && i < def.length; i++) {
            Object el = def[i];
            Object lo = get(el, "low_"), hi = get(el, "high_");
            Object oc = get(el, "outcome_");
            String on = name(oc);
            String r = hi == null ? (isNumber(lo) ? val(lo) : "\"" + val(lo) + "\"") : bound(lo, "low") + "-" + bound(hi, "hi");
            if (hi != null) warn("class set " + csName + " uses a range " + r + "; consumer treats both bounds as inclusive (unverified against SM)");
            ranges.computeIfAbsent(on, z -> new ArrayList<>()).add(r);
            outIdx.put(on, String.valueOf(get(oc, "index_")));
        }
        Object others = get(cs, "others_");
        Object t = get(get(cs, "type_"), "type_");
        StringBuilder b = new StringBuilder();
        b.append("<class_set name=\"").append(esc(csName)).append("\" data_type=\"").append(t).append("\" linked_characteristic_name=\"")
                .append(esc(linked)).append("\">\n").append(pad(6)).append("<base_class_set>\n");
        List<String[]> bins = new ArrayList<>();
        for (Map.Entry<String, List<String>> e : ranges.entrySet()) {
            b.append(pad(7)).append("<interval name=\"").append(esc(e.getKey())).append("\"><is_Others>false</is_Others><range>")
                    .append(esc(String.join(",", e.getValue()))).append("</range><outcome name=\"").append(esc(e.getKey())).append("\"/></interval>\n");
            bins.add(new String[]{outIdx.get(e.getKey()), e.getKey()});
        }
        if (others != null) {
            b.append(pad(7)).append("<interval name=\"").append(esc(name(others))).append("\"><is_Others>true</is_Others><range></range><outcome name=\"")
                    .append(esc(name(others))).append("\"/></interval>\n");
            bins.add(new String[]{String.valueOf(get(others, "index_")), name(others)});
        }
        b.append(pad(6)).append("</base_class_set>\n").append(pad(5)).append("</class_set>");
        String prev = classSets.get(csName);
        if (prev != null && !prev.equals(b.toString())) warn("class set name " + csName + " reused with different content; first one kept");
        if (prev == null) classSets.put(csName, b.toString());
        return bins;
    }

    static String bound(Object v, String inf) {
        String c = cls(v);
        if (c.equals("SMLow") || c.equals("SMHigh")) return inf;
        return val(v);
    }

    // ---------- policy rules ----------
    String policySet(Object fp) {
        Object rs = get(fp, "ruleSet_");
        String n = comp(name(rs));
        List<String> names = new ArrayList<>();
        StringBuilder cats = new StringBuilder();
        collectRules(get(rs, "rootNode_"), names, cats, Collections.newSetFromMap(new IdentityHashMap<>()));
        StringBuilder b = new StringBuilder();
        b.append("<policy_rule_set name=\"").append(esc(n)).append("\">\n");
        Object m = get(fp, "mappings_");
        for (String f : new String[]{"decisionCategoryMapping_", "decisionTextMapping_", "reasonCodeTableMapping_", "decisionTableMapping_", "policyRuleSetMapping_"}) {
            Object ch = get(m, f);
            if (ch != null) b.append(pad(6)).append("<output_mapping key=\"").append(f.replace("Mapping_", "")).append("\">").append(esc(charRef(ch).replace("'", ""))).append("</output_mapping>\n");
        }
        b.append(cats);
        b.append(pad(6)).append("<decision_category_to_policy_rule_map>\n");
        for (String r : names) {
            b.append(pad(7)).append("<map_element><mapped_policy_rule_name>").append(esc(r)).append("</mapped_policy_rule_name></map_element>\n");
        }
        b.append(pad(6)).append("</decision_category_to_policy_rule_map>\n").append(pad(5)).append("</policy_rule_set>");
        return register(ruleSets, n, b.toString(), "policy_rule_set");
    }

    void collectRules(Object node, List<String> names, StringBuilder cats, Set<Object> seen) {
        if (node == null || !seen.add(node)) return;
        Object cat = get(node, "category_");
        Object[] rs = (Object[]) get(node, "rules_");
        cats.append(pad(6)).append("<decision_category name=\"").append(esc(name(cat))).append("\" priority=\"").append(get(cat, "priority_"))
                .append("\" rules=\"").append(rs == null ? 0 : rs.length).append("\"/>\n");
        if (get(node, "true_") != null || get(node, "false_") != null) {
            warn("policy rule set node " + name(cat) + " has true_/false_ branches; flattened into one rule list");
        }
        for (int i = 0; rs != null && i < rs.length; i++) {
            Object r = rs[i];
            String[] v = {expr(get(r, "condition_")), val(get(r, "reasonCode_")), String.valueOf(!Boolean.FALSE.equals(get(r, "evaluationMode_")))};
            String n = comp(name(r));
            String[] prev = rules.get(n);
            if (prev != null && !Arrays.equals(prev, v)) warn("policy rule name " + n + " reused with different content; first one kept");
            if (prev == null) rules.put(n, v);
            if (!names.contains(n)) names.add(n);
        }
        collectRules(get(node, "true_"), names, cats, seen);
        collectRules(get(node, "false_"), names, cats, seen);
    }

    // ---------- scripts (SM source syntax as accepted by transfer/rulescript) ----------
    String script(Object e) {
        StringBuilder b = new StringBuilder("\n");
        stmt(e, 0, b);
        return b.toString();
    }

    void stmt(Object e, int ind, StringBuilder b) {
        if (e == null) return;
        String c = cls(e);
        switch (c) {
            case "RuntimeDoExpression":
                for (Object x : (Object[]) get(e, "expressions_")) stmt(x, ind, b);
                return;
            case "RuntimeIfExpression": {
                b.append(pad(ind)).append("IF ").append(expr(get(e, "condition_"))).append(" THEN\n");
                stmt(get(e, "body_"), ind + 1, b);
                Object el = get(e, "else_");
                int ifs = 1;
                while (el != null && cls(el).equals("RuntimeIfExpression")) {
                    b.append(pad(ind)).append("ELSE IF ").append(expr(get(el, "condition_"))).append(" THEN\n");
                    stmt(get(el, "body_"), ind + 1, b);
                    el = get(el, "else_");
                    ifs++;
                }
                if (el != null) {
                    b.append(pad(ind)).append("ELSE\n");
                    stmt(el, ind + 1, b);
                }
                for (int i = 0; i < ifs; i++) b.append(pad(ind)).append("ENDIF\n");
                return;
            }
            case "RuntimeAssignExpression":
                b.append(pad(ind)).append(charRef(get(e, "variable_"))).append("=").append(expr(get(e, "value_"))).append('\n');
                return;
            case "RuntimeWhileExpression":
                if (!inFunction) warn("WHILE outside a user function is emitted but untested against the consumer");
                b.append(pad(ind)).append("WHILE ").append(expr(get(e, "condition_"))).append(" LIMIT ").append(expr(get(e, "limit_"))).append('\n');
                stmt(get(e, "expression_"), ind + 1, b);
                b.append(pad(ind)).append("END_WHILE\n");
                return;
            case "RuntimeReturnExpression":
                b.append(pad(ind)).append("RETURN ").append(expr(get(e, "expression_"))).append('\n');
                return;
            default:
                warn("statement [" + c + "] not supported");
                b.append(pad(ind)).append("UNSUPPORTED_").append(c).append('\n');
        }
    }

    static final Map<String, String> CMP = new HashMap<>();
    static {
        CMP.put("RuntimeEqualToExpression", "=");
        CMP.put("RuntimeNotEqualToExpression", "<>");
        CMP.put("RuntimeGreaterThanExpression", ">");
        CMP.put("RuntimeGreaterThanOrEqualToExpression", ">=");
        CMP.put("RuntimeLessThanExpression", "<");
        CMP.put("RuntimeLessThanOrEqualToExpression", "<=");
    }

    String expr(Object e) {
        if (e == null) return "null";
        String c = cls(e);
        if (CMP.containsKey(c)) return expr(get(e, "expression_")) + " " + CMP.get(c) + " " + expr(get(e, "comparison_"));
        switch (c) {
            case "RuntimeVariableExpression":
                return charRef(get(e, "characteristic_"));
            case "RuntimeConstantExpression": {
                Object v = get(e, "value_");
                return isNumber(v) ? val(v) : "\"" + val(v) + "\"";
            }
            case "RuntimeANDExpression":
            case "RuntimeORExpression": {
                StringJoiner j = new StringJoiner(c.contains("AND") ? " AND " : " OR ", "(", ")");
                for (Object x : (Object[]) get(e, "expressions_")) j.add(expr(x));
                return j.toString();
            }
            case "RuntimeAdditionExpression":
            case "RuntimeMultiplicationExpression": {
                boolean add = c.contains("Addition");
                Object[] xs = (Object[]) get(e, "expressions_");
                boolean[] neg = (boolean[]) get(e, add ? "subtract_" : "divide_");
                String k = val(get(e, "constantValue_"));
                StringBuilder b = new StringBuilder("(");
                boolean first = true;
                if (add ? !isZero(k) : !k.equals("1")) { b.append(k); first = false; }
                for (int i = 0; i < xs.length; i++) {
                    boolean n = neg != null && neg[i];
                    if (first) b.append(n ? (add ? "-" : "1 / ") : "");
                    else b.append(n ? (add ? " - " : " / ") : (add ? " + " : " * "));
                    b.append(expr(xs[i]));
                    first = false;
                }
                return b.append(")").toString();
            }
            case "RuntimeNegateExpression":
                return "-" + expr(get(e, "expression_"));
            case "RuntimeSubstringExpression":
                return "SUBSTRING(" + expr(get(e, "expression_")) + ", " + expr(get(e, "offset_")) + ", " + expr(get(e, "length_")) + ")";
            case "RuntimeFindExpression":
                return "FIND(" + charRef(get(e, "variable_")) + ", " + expr(get(e, "expression_")) + ")";
            case "RuntimeToStringExpression":
                return "TOSTRING(" + expr(get(e, "expression_")) + ")";
            case "RuntimeToNumericExpression":
                return "TONUMERIC(" + expr(get(e, "expression_")) + ")";
            case "RuntimeToDateExpression":
                return "TODATE(" + expr(get(e, "expression_")) + ")";
            case "RuntimePowerExpression":
                return "POWER(" + expr(get(e, "expression_")) + ", " + expr(get(e, "power_")) + ")";
            case "RuntimeMonthsExpression":
                return "MONTHS(" + expr(get(e, "firstDate_")) + ", " + expr(get(e, "secondDate_")) + ")";
            case "RuntimeUserScriptFunctionExpression":
                return userFunction(e);
            default:
                warn("expression [" + c + "] not supported");
                return "UNSUPPORTED_" + c;
        }
    }

    String userFunction(Object e) {
        boolean outer = inFunction;
        inFunction = true;
        StringBuilder body = new StringBuilder();
        stmt(get(e, "expression_"), 0, body);
        inFunction = outer;
        String key = body.toString().replaceAll("\\s+", "");
        String fn = KNOWN_FUNCS.get(key);
        if (fn == null) {
            fn = "未识别函数" + Integer.toHexString(key.hashCode());
            warn("user script function body not recognised, emitted as '" + fn + "':\n" + body);
        }
        StringJoiner j = new StringJoiner(", ", "'" + fn + "'(", ")");
        Object ps = get(e, "parameters_");
        for (int i = 0; ps != null && i < Array.getLength(ps); i++) j.add(expr(Array.get(ps, i)));
        return j.toString();
    }

    /** Characteristic reference as SM source: '数据源.路径' (stack vars inside functions as $name). */
    String charRef(Object ch) {
        String c = cls(ch);
        if (c.equals("StackAtomicCharacteristic")) return "$" + name(ch);
        if (c.equals("ArrayIndexRuntimeCharacteristic")) return charRef(get(ch, "characteristic_")) + "[" + expr(get(ch, "index_")) + "]";
        if (c.equals("ArrayLookupRuntimeCharacteristic")) {
            warn("array lookup characteristic not supported");
            return charRef(get(ch, "characteristic_")) + "[UNSUPPORTED_LOOKUP]";
        }
        String n = name(ch);
        if (!inFunction) refChars.putIfAbsent(n, ch);
        return "'" + n + "'";
    }

    static boolean isZero(String k) {
        try { return Double.parseDouble(k) == 0d; } catch (Exception ex) { return false; }
    }
}
