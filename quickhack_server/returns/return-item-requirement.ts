export type ReturnItemRequirementInput = {
  externalShipmentId: string | null;
  externalVendorItemId: string | null;
  cancelCount: number;
  vendorItemName?: string | null;
};

export type ReturnAllocationCandidate = {
  allocationId: number;
  externalShipmentId: string | null;
  externalVendorItemId: string | null;
  pgNo: string;
};

export type ReturnItemRequirement = {
  key: string;
  externalShipmentId: string;
  externalVendorItemId: string;
  vendorItemName: string | null;
  requiredQuantity: number;
  selectableQuantity: number;
  missingQuantity: number;
  candidateAllocationIds: number[];
};

export type ReturnItemRequirementResult = {
  integrityStatus: "VALID" | "MISSING_IDENTITY" | "INVALID_QUANTITY" | "COUNT_MISMATCH";
  requirements: ReturnItemRequirement[];
  totalRequiredQuantity: number;
  totalSelectableQuantity: number;
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

export function returnItemRequirementKey(input: {
  externalShipmentId: string | null;
  externalVendorItemId: string | null;
}) {
  return `${text(input.externalShipmentId)}\u0000${text(input.externalVendorItemId)}`;
}

export function buildReturnItemRequirements(input: {
  rootCancelCount: number;
  items: readonly ReturnItemRequirementInput[];
  allocations: readonly ReturnAllocationCandidate[];
}): ReturnItemRequirementResult {
  const rootCancelCount = Number(input.rootCancelCount);
  if (!Number.isSafeInteger(rootCancelCount) || rootCancelCount <= 0) {
    return {
      integrityStatus: "INVALID_QUANTITY",
      requirements: [],
      totalRequiredQuantity: 0,
      totalSelectableQuantity: 0,
    };
  }

  const grouped = new Map<
    string,
    {
      externalShipmentId: string;
      externalVendorItemId: string;
      vendorItemName: string | null;
      requiredQuantity: number;
    }
  >();
  for (const item of input.items) {
    const externalShipmentId = text(item.externalShipmentId);
    const externalVendorItemId = text(item.externalVendorItemId);
    if (!externalShipmentId || !externalVendorItemId) {
      return {
        integrityStatus: "MISSING_IDENTITY",
        requirements: [],
        totalRequiredQuantity: 0,
        totalSelectableQuantity: 0,
      };
    }
    if (!Number.isSafeInteger(item.cancelCount) || item.cancelCount <= 0) {
      return {
        integrityStatus: "INVALID_QUANTITY",
        requirements: [],
        totalRequiredQuantity: 0,
        totalSelectableQuantity: 0,
      };
    }
    const key = returnItemRequirementKey({
      externalShipmentId,
      externalVendorItemId,
    });
    const existing = grouped.get(key);
    grouped.set(key, {
      externalShipmentId,
      externalVendorItemId,
      vendorItemName:
        existing?.vendorItemName ?? (text(item.vendorItemName) || null),
      requiredQuantity: (existing?.requiredQuantity ?? 0) + item.cancelCount,
    });
  }

  const totalRequiredQuantity = [...grouped.values()].reduce(
    (sum, requirement) => sum + requirement.requiredQuantity,
    0
  );
  if (totalRequiredQuantity !== rootCancelCount) {
    return {
      integrityStatus: "COUNT_MISMATCH",
      requirements: [],
      totalRequiredQuantity,
      totalSelectableQuantity: 0,
    };
  }

  const requirements = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, requirement]) => {
      const candidateAllocationIds = input.allocations
        .filter(
          (allocation) =>
            text(allocation.externalShipmentId) === requirement.externalShipmentId &&
            text(allocation.externalVendorItemId) === requirement.externalVendorItemId
        )
        .map((allocation) => allocation.allocationId)
        .sort((left, right) => left - right);
      const selectableQuantity = Math.min(
        requirement.requiredQuantity,
        candidateAllocationIds.length
      );
      return {
        key,
        ...requirement,
        selectableQuantity,
        missingQuantity: Math.max(
          0,
          requirement.requiredQuantity - candidateAllocationIds.length
        ),
        candidateAllocationIds,
      };
    });

  return {
    integrityStatus: "VALID",
    requirements,
    totalRequiredQuantity,
    totalSelectableQuantity: requirements.reduce(
      (sum, requirement) => sum + requirement.selectableQuantity,
      0
    ),
  };
}

export function assertReturnSelectionMatchesRequirements(input: {
  result: ReturnItemRequirementResult;
  selectedAllocationIds: readonly number[];
}) {
  if (input.result.integrityStatus !== "VALID") {
    throw new Error(
      `반품 품목 범위를 확정할 수 없습니다: ${input.result.integrityStatus}`
    );
  }
  const selected = new Set(input.selectedAllocationIds);
  if (selected.size !== input.selectedAllocationIds.length) {
    throw new Error("반품 PG 선택에 중복된 항목이 있습니다.");
  }
  const allCandidateIds = new Set(
    input.result.requirements.flatMap(
      (requirement) => requirement.candidateAllocationIds
    )
  );
  for (const allocationId of selected) {
    if (!allCandidateIds.has(allocationId)) {
      throw new Error("선택한 PG가 반품 품목 범위에 포함되지 않습니다.");
    }
  }
  for (const requirement of input.result.requirements) {
    const selectedCount = requirement.candidateAllocationIds.filter(
      (allocationId) => selected.has(allocationId)
    ).length;
    if (selectedCount !== requirement.selectableQuantity) {
      throw new Error(
        `반품 품목 ${requirement.externalVendorItemId}의 PG를 ${requirement.selectableQuantity}개 선택해야 합니다.`
      );
    }
  }
}
