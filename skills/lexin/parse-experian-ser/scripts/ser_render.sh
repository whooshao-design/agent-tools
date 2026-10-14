#!/usr/bin/env bash
# Render a decrypted Experian Strategy Manager .ser (Java-serialized ExecutableStrategy).
# Usage: ser_render.sh FILE.ser [pretty|dump] > out.txt
#   pretty: readable flow / rules / scripts (default); dump: full generic object-tree dump.
# Needs JDK 8 and com.experian:da/das/resource:1.0.0 in ~/.m2 (server_credit_ser_deploy_java deps).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
classes=${XDG_CACHE_HOME:-$HOME/.cache}/parse-experian-ser/classes
m2=${M2_REPO:-$HOME/.m2/repository}/com/experian
cp="$m2/da/1.0.0/da-1.0.0.jar:$m2/das/1.0.0/das-1.0.0.jar:$m2/resource/1.0.0/resource-1.0.0.jar:$classes"
for j in da das resource; do
  [ -f "$m2/$j/1.0.0/$j-1.0.0.jar" ] || { echo "missing $m2/$j/1.0.0/$j-1.0.0.jar" >&2; exit 3; }
done
if [ ! -f "$classes/SerPretty.class" ] || [ "$here/SerPretty.java" -nt "$classes/SerPretty.class" ] \
   || [ "$here/SerDump.java" -nt "$classes/SerDump.class" ]; then
  mkdir -p "$classes"
  javac -encoding UTF-8 -d "$classes" "$here/SerPretty.java" "$here/SerDump.java"
fi
case "${2:-pretty}" in
  pretty) exec java -cp "$cp" SerPretty "$1" ;;
  dump)   exec java -cp "$cp" SerDump "$1" ;;
  *) echo "mode must be pretty|dump" >&2; exit 2 ;;
esac
