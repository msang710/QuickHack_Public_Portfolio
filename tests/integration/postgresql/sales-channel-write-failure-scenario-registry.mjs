export const SALES_CHANNEL_WRITE_FAILURE_SCENARIO = Object.freeze({
  CHANGED_NOT_APPLIED_COMMAND_REPLACES_SNAPSHOT:
    "changed-not-applied-command-replaces-snapshot",
  CHANGED_REJECTED_COMMAND_REPLACES_SNAPSHOT:
    "changed-rejected-command-replaces-snapshot",
  CONCURRENT_CHANGED_RETRIES_HAVE_ONE_WINNER:
    "concurrent-changed-retries-have-one-winner",
  RETRY_SNAPSHOT_FAILURE_ROLLS_BACK:
    "retry-snapshot-failure-rolls-back",
});

export const salesChannelWriteFailureScenarioIds = Object.freeze(
  Object.values(SALES_CHANNEL_WRITE_FAILURE_SCENARIO)
);

function validateImplementations(implementations) {
  if (
    implementations === null ||
    typeof implementations !== "object" ||
    Array.isArray(implementations)
  ) {
    throw new TypeError("Sales-channel failure scenario implementations must be an object.");
  }

  const implementationIds = Object.keys(implementations);
  const missingIds = salesChannelWriteFailureScenarioIds.filter(
    (scenarioId) => !Object.hasOwn(implementations, scenarioId)
  );
  const unknownIds = implementationIds.filter(
    (scenarioId) => !salesChannelWriteFailureScenarioIds.includes(scenarioId)
  );

  if (missingIds.length > 0 || unknownIds.length > 0) {
    throw new Error(
      `Sales-channel failure scenario registry mismatch: missing=[${missingIds.join(",")}], unknown=[${unknownIds.join(",")}].`
    );
  }

  for (const scenarioId of salesChannelWriteFailureScenarioIds) {
    if (typeof implementations[scenarioId] !== "function") {
      throw new TypeError(
        `Sales-channel failure scenario '${scenarioId}' must be implemented by a function.`
      );
    }
  }
}

export async function runSalesChannelWriteFailureScenarios(
  api,
  implementations
) {
  validateImplementations(implementations);
  const executedScenarioIds = [];

  for (const scenarioId of salesChannelWriteFailureScenarioIds) {
    await implementations[scenarioId](api);
    executedScenarioIds.push(scenarioId);
  }

  return Object.freeze(executedScenarioIds);
}
