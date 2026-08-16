import type { ProductOption } from "@/quickhack_client/components/inspection/inspection-product-criteria";
import type { ProductCriteriaOptionDto } from "@/quickhack_shared/catalog/product-criteria";

function uniqueSorted(values: Iterable<string>) {
  return Array.from(new Set(Array.from(values).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b, "ko")
  );
}

function colorDescription(models: string[]) {
  if (models.length === 0) {
    return "";
  }

  if (models.length <= 3) {
    return models.join(", ");
  }

  return `${models.slice(0, 3).join(", ")} 외 ${models.length - 3}개 기종`;
}

// QuickHack object: 공식 색상명을 상품 기준값의 기종 관계로 정렬하고 기종 설명을 붙인 검수용 옵션으로 변환합니다.
export function buildInspectionColorOptions({
  colors,
  colorModelsByColor,
  rawOptions,
}: {
  colors: string[];
  colorModelsByColor: Record<string, string[]>;
  rawOptions: ProductCriteriaOptionDto[];
}): ProductOption[] {
  const modelsByColor = new Map<string, Set<string>>();

  for (const [color, models] of Object.entries(colorModelsByColor)) {
    const normalizedColor = color.trim();

    if (!normalizedColor) {
      continue;
    }

    const currentModels = modelsByColor.get(normalizedColor) ?? new Set<string>();

    for (const model of models) {
      const normalizedModel = model.trim();

      if (normalizedModel) {
        currentModels.add(normalizedModel);
      }
    }

    modelsByColor.set(normalizedColor, currentModels);
  }

  for (const option of rawOptions) {
    if (option.category !== "DEVICE_COLOR" || !option.isActive) {
      continue;
    }

    const color = option.label.trim() || option.optionKey.trim();
    const model = option.parentKey.trim();

    if (!color || !model) {
      continue;
    }

    const models = modelsByColor.get(color) ?? new Set<string>();
    models.add(model);
    modelsByColor.set(color, models);
  }

  return colors
    .map((color) => {
      const models = uniqueSorted(modelsByColor.get(color) ?? []);
      const description = colorDescription(models);
      const firstModel = models[0] ?? "\uffff";

      return {
        value: color,
        label: color,
        description,
        searchText: `${color} ${models.join(" ")}`.toLowerCase(),
        sortKey: `${firstModel}\u0000${color}`,
      };
    })
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey, "ko"))
    .map((option) => ({
      value: option.value,
      label: option.label,
      description: option.description,
      searchText: option.searchText,
    }));
}
