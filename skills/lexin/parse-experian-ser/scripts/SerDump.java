import java.io.*;
import java.lang.reflect.*;
import java.util.*;

/**
 * Generic dumper for decrypted Experian Strategy Manager .ser (ExecutableStrategy) files.
 * Deserializes with com.experian:da/das/resource 1.0.0 on the classpath and prints the whole
 * object graph as an indented tree. Revisited objects are printed as "@<id>" references.
 * Usage: java -cp <jars>:classes SerDump <file.ser> [maxDepth]
 */
public class SerDump {
    private final IdentityHashMap<Object, Integer> seen = new IdentityHashMap<>();
    private final PrintStream out;
    private final int maxDepth;

    SerDump(PrintStream out, int maxDepth) { this.out = out; this.maxDepth = maxDepth; }

    public static void main(String[] args) throws Exception {
        int depth = args.length > 1 ? Integer.parseInt(args[1]) : 200;
        try (ObjectInputStream in = new ObjectInputStream(new BufferedInputStream(new FileInputStream(args[0])))) {
            Object root = in.readObject();
            new SerDump(System.out, depth).dump("root", root, 0);
        }
    }

    static boolean isLeaf(Object o) {
        return o instanceof String || o instanceof Number || o instanceof Boolean || o instanceof Character
                || o instanceof Enum || o instanceof Class;
    }

    /** SMCharArray stores strings as char[] + start/length. */
    static String smChars(Object o) {
        if (o == null || !o.getClass().getName().endsWith("SMCharArray")) return null;
        try {
            char[] d = (char[]) get(o, "data_");
            int s = (Integer) get(o, "start_"), l = (Integer) get(o, "length_");
            return d == null ? "" : new String(d, s, Math.min(l, d.length - s));
        } catch (Exception e) { return null; }
    }

    static Object get(Object o, String name) throws Exception {
        for (Class<?> c = o.getClass(); c != null; c = c.getSuperclass()) {
            try { Field f = c.getDeclaredField(name); f.setAccessible(true); return f.get(o); }
            catch (NoSuchFieldException ignore) { }
        }
        throw new NoSuchFieldException(name);
    }

    static String esc(String s) {
        return s.replace("\\", "\\\\").replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t");
    }

    void line(int ind, String s) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < ind; i++) b.append("  ");
        out.println(b.append(s));
    }

    void dump(String name, Object o, int ind) throws Exception {
        if (o == null) { line(ind, name + " = null"); return; }
        if (isLeaf(o)) { line(ind, name + " = " + (o instanceof String ? "\"" + esc((String) o) + "\"" : String.valueOf(o))); return; }
        String sm = smChars(o);
        if (sm != null) { line(ind, name + " = \"" + esc(sm) + "\"  (SMCharArray)"); return; }
        Class<?> c = o.getClass();
        if (c.isArray() && c.getComponentType().isPrimitive()) {
            if (c.getComponentType() == char.class) { line(ind, name + " = char[]\"" + esc(new String((char[]) o)) + "\""); return; }
            int n = Array.getLength(o);
            StringBuilder b = new StringBuilder();
            for (int i = 0; i < Math.min(n, 64); i++) b.append(i == 0 ? "" : ",").append(Array.get(o, i));
            line(ind, name + " = " + c.getComponentType() + "[" + n + "]{" + b + (n > 64 ? ",..." : "") + "}");
            return;
        }
        Integer id = seen.get(o);
        if (id != null) { line(ind, name + " = @" + id + " " + shortName(c)); return; }
        id = seen.size() + 1;
        seen.put(o, id);
        if (ind > maxDepth) { line(ind, name + " = #" + id + " " + shortName(c) + " {...depth}"); return; }
        if (c.isArray()) {
            int n = Array.getLength(o);
            line(ind, name + " = #" + id + " " + shortName(c) + "[" + n + "]");
            for (int i = 0; i < n; i++) dump("[" + i + "]", Array.get(o, i), ind + 1);
            return;
        }
        if (o instanceof Collection && c.getName().startsWith("java.")) {
            line(ind, name + " = #" + id + " " + shortName(c) + " size=" + ((Collection<?>) o).size());
            int i = 0;
            for (Object e : (Collection<?>) o) dump("[" + (i++) + "]", e, ind + 1);
            return;
        }
        if (o instanceof Map && c.getName().startsWith("java.")) {
            line(ind, name + " = #" + id + " " + shortName(c) + " size=" + ((Map<?, ?>) o).size());
            for (Map.Entry<?, ?> e : ((Map<?, ?>) o).entrySet()) {
                Object k = e.getKey();
                String ks = isLeaf(k) ? String.valueOf(k) : (smChars(k) != null ? smChars(k) : shortName(k.getClass()));
                dump("{" + esc(ks) + "}", e.getValue(), ind + 1);
            }
            return;
        }
        line(ind, name + " = #" + id + " " + shortName(c));
        if (c.getName().startsWith("java.")) { line(ind + 1, "toString=" + esc(String.valueOf(o))); return; }
        for (Class<?> k = c; k != null && k != Object.class; k = k.getSuperclass()) {
            for (Field f : k.getDeclaredFields()) {
                if (Modifier.isStatic(f.getModifiers())) continue;
                f.setAccessible(true);
                dump(f.getName(), f.get(o), ind + 1);
            }
        }
    }

    static String shortName(Class<?> c) {
        return c.getName().replace("com.experian.stratman.", "");
    }
}
