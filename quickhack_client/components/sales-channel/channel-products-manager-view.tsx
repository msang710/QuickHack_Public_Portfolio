// QuickHack note: 판매 채널에서 수집된 상품/옵션 구조를 읽기 전용으로 조회하는 화면입니다.
"use client";

import * as React from "react";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import { useTranslations } from "next-intl";
import {
  CheckCheck,
  ListChecks,
  PackageSearch,
  RefreshCcw,
  Store,
} from "lucide-react";
import { Badge } from "@/quickhack_client/components/ui/badge";
import { Button } from "@/quickhack_client/components/ui/button";
import { FeedbackBanner } from "@/quickhack_client/components/ui/feedback-banner";
import { SearchInput } from "@/quickhack_client/components/ui/search-input";
import {
  SummaryMetric as SummaryCell,
  SummaryStrip,
} from "@/quickhack_client/components/ui/summary-metric";
import {
  MasterDetailLayout,
  PanelToolbar,
  WorkspacePanel,
} from "@/quickhack_client/components/ui/workspace-layout";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/quickhack_client/components/ui/select";
import {
  type DataGridColumn,
  VirtualizedDataGrid,
} from "@/quickhack_client/components/ui/virtualized-data-grid";
import {
  DetailRow,
  formatDate,
} from "@/quickhack_client/components/shared/device-detail-sheet";
import { cn } from "@/quickhack_shared/core/utils";

type ChannelProductOptionDto = {
  mappingId: number;
  channel: string;
  externalProductId: string | null;
  productKey: string;
  productName: string | null;
  externalVendorItemId: string;
  externalOptionName: string | null;
  vendorItemName: string | null;
  sellerProductItemName: string | null;
  externalVendorSkuCode: string | null;
  mappingStatus: string;
  salesOfferId: number | null;
  salesOfferCode: string | null;
  model: string | null;
  requiredStorage: string | null;
  requiredColor: string | null;
  requiredWarrantyGroup: string | null;
  requiredWarrantyLabel: string | null;
  orderItemCount: number;
  availableQuantity: number;
  cancelQuantity: number;
  lastOrderedAt: string | null;
  mappedAt: string | null;
  updatedAt: string | null;
};

type ChannelProductDto = {
  productKey: string;
  channel: string;
  externalProductId: string | null;
  productName: string;
  optionCount: number;
  mappedOptionCount: number;
  unmappedOptionCount: number;
  orderItemCount: number;
  availableQuantity: number;
  lastOrderedAt: string | null;
  updatedAt: string | null;
  options: ChannelProductOptionDto[];
};

type ChannelProductsApiResponse = {
  ok: boolean;
  message?: string;
  items?: ChannelProductDto[];
  count?: number;
  completeness?: {
    complete: boolean;
    pageCount: number;
    sellerProductCount: number;
    optionCount: number;
    completedAt: string;
  };
};

function statusBadge(status: string, mapped: string, unmapped: string) {
  if (status === "MAPPED") {
    return <Badge variant="success">{mapped}</Badge>;
  }

  return <Badge variant="warning">{unmapped}</Badge>;
}

function productSearchText(product: ChannelProductDto) {
  return [
    product.channel,
    product.externalProductId,
    product.productName,
    product.options
      .map((option) =>
        [
          option.externalVendorItemId,
          option.externalOptionName,
          option.vendorItemName,
          option.sellerProductItemName,
          option.externalVendorSkuCode,
          option.salesOfferCode,
          option.model,
          option.requiredStorage,
          option.requiredColor,
          option.requiredWarrantyLabel,
        ]
          .filter(Boolean)
          .join(" ")
      )
      .join(" "),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function optionName(option: ChannelProductOptionDto) {
  return (
    option.externalOptionName ||
    option.sellerProductItemName ||
    option.vendorItemName ||
    "-"
  );
}

export function ChannelProductsManagerView() {
  const t = useTranslations("salesChannel.channelProducts");
  const [products, setProducts] = React.useState<ChannelProductDto[]>([]);
  const [selectedProductKey, setSelectedProductKey] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<
    "ALL" | "MAPPED" | "UNMAPPED"
  >("ALL");
  const [isLoading, setIsLoading] = React.useState(true);
  const [message, setMessage] = React.useState("");
  const selectedProductKeyRef = React.useRef("");
  const loadGenerationRef = React.useRef(0);

  const selectedProduct = React.useMemo(
    () =>
      products.find((product) => product.productKey === selectedProductKey) ??
      null,
    [products, selectedProductKey]
  );
  const filteredProducts = React.useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return products.filter((product) => {
      if (statusFilter === "MAPPED" && product.unmappedOptionCount > 0) {
        return false;
      }

      if (statusFilter === "UNMAPPED" && product.unmappedOptionCount === 0) {
        return false;
      }

      return normalizedQuery
        ? productSearchText(product).includes(normalizedQuery)
        : true;
    });
  }, [products, query, statusFilter]);
  const totalOptionCount = products.reduce(
    (sum, product) => sum + product.optionCount,
    0
  );
  const mappedOptionCount = products.reduce(
    (sum, product) => sum + product.mappedOptionCount,
    0
  );
  const unmappedOptionCount = totalOptionCount - mappedOptionCount;

  const productColumns = React.useMemo<
    DataGridColumn<
      | "productName"
      | "externalProductId"
      | "optionCount"
      | "mappedOptionCount"
      | "orderItemCount"
      | "availableQuantity"
      | "updatedAt",
      ChannelProductDto
    >[]
  >(
    () => [
      {
        key: "productName",
        label: t("columns.product"),
        width: "minmax(300px,1fr)",
        placeholder: t("columns.productName"),
        cellClassName: "min-w-0 px-3 py-2",
        render: (product) => (
          <>
            <div className="truncate font-medium">{product.productName}</div>
            <div className="truncate text-xs text-muted-foreground">
              {product.channel}
            </div>
          </>
        ),
        text: (product) => product.productName,
      },
      {
        key: "externalProductId",
        label: t("columns.productId"),
        width: "150px",
        placeholder: t("columns.productId"),
        cellClassName: "flex items-center px-3 font-mono text-xs",
        render: (product) => product.externalProductId || "-",
        text: (product) => product.externalProductId || "",
      },
      {
        key: "optionCount",
        label: t("columns.option"),
        width: "80px",
        headerClassName: "justify-end",
        cellClassName: "flex items-center justify-end px-3 tabular-nums",
        render: (product) => product.optionCount,
        text: (product) => String(product.optionCount),
        sortValue: (product) => product.optionCount,
      },
      {
        key: "mappedOptionCount",
        label: t("columns.mapping"),
        width: "110px",
        headerClassName: "justify-end",
        cellClassName: "flex items-center justify-end px-3 tabular-nums",
        render: (product) =>
          `${product.mappedOptionCount}/${product.optionCount}`,
        text: (product) => `${product.mappedOptionCount}/${product.optionCount}`,
        sortValue: (product) => product.mappedOptionCount,
      },
      {
        key: "orderItemCount",
        label: t("columns.orders"),
        width: "90px",
        headerClassName: "justify-end",
        cellClassName: "flex items-center justify-end px-3 tabular-nums",
        render: (product) => product.orderItemCount,
        text: (product) => String(product.orderItemCount),
        sortValue: (product) => product.orderItemCount,
      },
      {
        key: "availableQuantity",
        label: t("columns.available"),
        width: "100px",
        headerClassName: "justify-end",
        cellClassName: "flex items-center justify-end px-3 tabular-nums",
        render: (product) => product.availableQuantity,
        text: (product) => String(product.availableQuantity),
        sortValue: (product) => product.availableQuantity,
      },
      {
        key: "updatedAt",
        label: t("columns.updated"),
        width: "140px",
        placeholder: t("columns.updatedAt"),
        cellClassName: "flex items-center px-3 text-xs",
        render: (product) => formatDate(product.updatedAt),
        text: (product) => product.updatedAt || "",
      },
    ],
    [t]
  );

  const optionColumns = React.useMemo<
    DataGridColumn<
      | "externalVendorItemId"
      | "optionName"
      | "mappingStatus"
      | "salesOfferCode"
      | "requiredStorage"
      | "requiredColor"
      | "orderItemCount",
      ChannelProductOptionDto
    >[]
  >(
    () => [
      {
        key: "externalVendorItemId",
        label: "vendorItemId",
        width: "160px",
        placeholder: "vendorItemId",
        cellClassName: "flex items-center px-3 font-mono text-xs",
        render: (option) => option.externalVendorItemId,
        text: (option) => option.externalVendorItemId,
      },
      {
        key: "optionName",
        label: t("columns.option"),
        width: "minmax(220px,1fr)",
        placeholder: t("columns.optionName"),
        cellClassName: "min-w-0 px-3 py-2",
        render: (option) => (
          <>
            <div className="truncate font-medium">{optionName(option)}</div>
            <div className="truncate text-xs text-muted-foreground">
              {option.externalVendorSkuCode || option.vendorItemName || "-"}
            </div>
          </>
        ),
        text: (option) =>
          [
            optionName(option),
            option.externalVendorSkuCode,
            option.vendorItemName,
          ]
            .filter(Boolean)
            .join(" "),
      },
      {
        key: "mappingStatus",
        label: t("columns.status"),
        width: "90px",
        placeholder: t("columns.status"),
        cellClassName: "flex items-center px-3",
        render: (option) => statusBadge(
          option.mappingStatus,
          t("common.mapped"),
          t("common.unmapped")
        ),
        text: (option) => option.mappingStatus,
      },
      {
        key: "salesOfferCode",
        label: t("columns.offer"),
        width: "200px",
        placeholder: t("columns.offerShort"),
        cellClassName: "min-w-0 px-3 py-2",
        render: (option) => (
          <>
            <div className="truncate font-mono text-xs">
              {option.salesOfferCode || "-"}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {option.requiredWarrantyLabel || "-"}
            </div>
          </>
        ),
        text: (option) =>
          [option.salesOfferCode, option.model, option.requiredWarrantyLabel]
            .filter(Boolean)
            .join(" "),
      },
      {
        key: "requiredStorage",
        label: t("columns.storage"),
        width: "90px",
        placeholder: t("columns.storage"),
        cellClassName: "flex items-center px-3",
        render: (option) => option.requiredStorage || "-",
        text: (option) => option.requiredStorage || "",
      },
      {
        key: "requiredColor",
        label: t("columns.color"),
        width: "110px",
        placeholder: t("columns.color"),
        cellClassName: "flex items-center px-3",
        render: (option) => option.requiredColor || "-",
        text: (option) => option.requiredColor || "",
      },
      {
        key: "orderItemCount",
        label: t("columns.orders"),
        width: "80px",
        headerClassName: "justify-end",
        cellClassName: "flex items-center justify-end px-3 tabular-nums",
        render: (option) => option.orderItemCount,
        text: (option) => String(option.orderItemCount),
        sortValue: (option) => option.orderItemCount,
      },
    ],
    [t]
  );

  const loadData = React.useCallback(async () => {
    const generation = loadGenerationRef.current + 1;

    loadGenerationRef.current = generation;
    setIsLoading(true);
    setMessage("");

    try {
      const response = await fetch("/api/coupang/channel-products", {
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => null)) as
        | ChannelProductsApiResponse
        | null;

      if (!response.ok || !payload?.ok) {
        throw new Error(legacyApiMessage(payload, t("message.loadFailed")));
      }

      if (!payload.completeness?.complete) {
        throw new Error(
          t("message.incomplete")
        );
      }

      if (generation !== loadGenerationRef.current) {
        return;
      }

      const nextProducts = payload.items ?? [];
      const currentProductKey = selectedProductKeyRef.current;
      const nextProductKey =
        currentProductKey &&
        nextProducts.some((product) => product.productKey === currentProductKey)
          ? currentProductKey
          : nextProducts[0]?.productKey ?? "";

      selectedProductKeyRef.current = nextProductKey;
      setProducts(nextProducts);
      setSelectedProductKey(nextProductKey);
    } catch (error) {
      if (generation === loadGenerationRef.current) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (generation === loadGenerationRef.current) {
        setIsLoading(false);
      }
    }
  }, [t]);

  React.useEffect(() => {
    const timerId = window.setTimeout(() => {
      void loadData();
    }, 0);

    return () => window.clearTimeout(timerId);
  }, [loadData]);

  function selectProduct(product: ChannelProductDto) {
    selectedProductKeyRef.current = product.productKey;
    setSelectedProductKey(product.productKey);
  }

  return (
    <MasterDetailLayout
      as="section"
      className="grid-cols-[minmax(700px,1fr)_520px] gap-4 p-5"
    >
      <div className="flex min-h-0 flex-col gap-4">
        <SummaryStrip className="grid-cols-4">
          <SummaryCell icon={Store} label={t("summary.products")} value={products.length} />
          <SummaryCell icon={PackageSearch} label={t("summary.options")} value={totalOptionCount} />
          <SummaryCell icon={CheckCheck} label={t("summary.mapped")} value={mappedOptionCount} />
          <SummaryCell icon={ListChecks} label={t("summary.unmapped")} value={unmappedOptionCount} />
        </SummaryStrip>

        <WorkspacePanel className="flex-1">
          <PanelToolbar className="xl:grid-cols-[340px_160px_auto]">
            <SearchInput
              placeholder={t("toolbar.search")}
              value={query}
              onValueChange={setQuery}
            />

            <Select
              value={statusFilter}
              onValueChange={(value) =>
                setStatusFilter(value as "ALL" | "MAPPED" | "UNMAPPED")
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t("toolbar.all")}</SelectItem>
                <SelectItem value="MAPPED">{t("toolbar.fullyMapped")}</SelectItem>
                <SelectItem value="UNMAPPED">{t("toolbar.includesUnmapped")}</SelectItem>
              </SelectContent>
            </Select>

            <Button variant="outline" onClick={() => void loadData()}>
              <RefreshCcw className={cn("size-4", isLoading && "animate-spin")} />
              {t("toolbar.refresh")}
            </Button>
          </PanelToolbar>

          {message ? (
            <FeedbackBanner
              tone="warning"
              className="rounded-none border-x-0 border-t-0 px-4"
            >
              {message}
            </FeedbackBanner>
          ) : null}

          <VirtualizedDataGrid
            rows={filteredProducts}
            columns={productColumns}
            rowKey={(product) => product.productKey}
            emptyMessage={
              isLoading
                ? t("toolbar.loading")
                : t("toolbar.empty")
            }
            selectedRowKey={selectedProductKey}
            onRowClick={selectProduct}
            className="rounded-none border-0"
            minWidth="1120px"
            rowHeight={58}
          />
        </WorkspacePanel>
      </div>

      <aside className="flex min-h-0 flex-col rounded-md border bg-popover">
        <div className="flex items-start justify-between gap-3 border-b p-4">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">
              {selectedProduct?.productName ?? t("detail.selectTitle")}
            </h2>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {selectedProduct?.externalProductId ?? "-"}
            </p>
          </div>
          <Badge variant="neutral" className="shrink-0">
            {t("detail.readOnly")}
          </Badge>
        </div>

        {selectedProduct ? (
          <>
            <div className="grid gap-3 border-b p-4">
              <div className="rounded-md border bg-background px-3 py-2">
                <DetailRow label={t("detail.channel")} value={selectedProduct.channel} />
                <DetailRow
                  label={t("detail.productId")}
                  value={selectedProduct.externalProductId}
                />
                <DetailRow
                  label={t("detail.options")}
                  value={t("detail.optionCount", { count: selectedProduct.optionCount })}
                />
                <DetailRow
                  label={t("detail.mapping")}
                  value={`${selectedProduct.mappedOptionCount}/${selectedProduct.optionCount}`}
                />
                <DetailRow
                  label={t("detail.orderItems")}
                  value={t("detail.orderCount", { count: selectedProduct.orderItemCount })}
                />
                <DetailRow
                  label={t("detail.available")}
                  value={String(selectedProduct.availableQuantity)}
                />
                <DetailRow
                  label={t("detail.lastOrder")}
                  value={formatDate(selectedProduct.lastOrderedAt)}
                />
                <DetailRow
                  label={t("detail.updated")}
                  value={formatDate(selectedProduct.updatedAt)}
                />
              </div>
            </div>

            <div className="min-h-0 flex-1">
              <VirtualizedDataGrid
                rows={selectedProduct.options}
                columns={optionColumns}
                rowKey={(option) => option.externalVendorItemId}
                emptyMessage={t("detail.emptyOptions")}
                className="rounded-none border-0"
                minWidth="960px"
                rowHeight={58}
              />
            </div>
          </>
        ) : (
          <div className="grid min-h-80 place-items-center p-4 text-sm text-muted-foreground">
            {t("detail.select")}
          </div>
        )}
      </aside>
    </MasterDetailLayout>
  );
}
