export function createDeterministicConcurrencyHarness(scenario) {
  const arrivals = new Map();
  const releases = new Map();
  const events = [];

  function signal(map, key) {
    let resolve;
    const promise = new Promise((next) => {
      resolve = next;
    });
    map.set(key, { promise, resolve });
    return map.get(key);
  }

  function entry(map, key) {
    return map.get(key) ?? signal(map, key);
  }

  return {
    async arrive(actor, checkpoint) {
      const key = `${actor}:${checkpoint}`;
      events.push({ type: "ARRIVED", actor, checkpoint });
      entry(arrivals, key).resolve();
      await entry(releases, key).promise;
      events.push({ type: "RELEASED", actor, checkpoint });
    },
    waitFor(actor, checkpoint) {
      return entry(arrivals, `${actor}:${checkpoint}`).promise;
    },
    release(actor, checkpoint) {
      entry(releases, `${actor}:${checkpoint}`).resolve();
    },
    artifact(extra = {}) {
      return { scenario, events: [...events], ...extra };
    },
  };
}
