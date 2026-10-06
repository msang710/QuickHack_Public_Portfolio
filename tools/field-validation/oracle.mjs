function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function compareBusinessState(expected, actual) {
  const mismatches = [];
  function walk(want, got, path) {
    if (plainObject(want)) {
      if (!plainObject(got)) {
        mismatches.push({ path, expected: want, actual: got });
        return;
      }
      for (const key of new Set([...Object.keys(want), ...Object.keys(got)])) {
        walk(want[key], got[key], path ? `${path}.${key}` : key);
      }
      return;
    }
    if (Array.isArray(want) || Array.isArray(got)) {
      if (JSON.stringify(want) !== JSON.stringify(got)) mismatches.push({ path, expected: want, actual: got });
      return;
    }
    if (!Object.is(want, got)) mismatches.push({ path, expected: want, actual: got });
  }
  walk(expected, actual, "");
  return { ok: mismatches.length === 0, mismatches };
}
