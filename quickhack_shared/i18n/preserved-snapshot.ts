/** Marks a Korean historical/operator snapshot that must remain verbatim beside its semantic code. */
export function preserveKoreanSnapshot<const Value extends string>(value: Value): Value {
  return value;
}
