// QuickHack note: 판매 채널에서 수집된 상품/옵션 구조를 읽기 전용으로 조회하는 화면입니다.
"use client";

import * as React from "react";
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

function statusBadge(status: string) {
  if (status === "MAPPED") {
    return <Badge variant="success">매핑됨</Badge>;
  }

  return <Badge variant="warning">미매핑</Badge>;
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
        label: "상품",
        width: "minmax(300px,1fr)",
        placeholder: "상품명",
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
        label: "상품 ID",
        width: "150px",
        placeholder: "상품 ID",
        cellClassName: "flex items-center px-3 font-mono text-xs",
        render: (product) => product.externalProductId || "-",
        text: (product) => product.externalProductId || "",
      },
      {
        key: "optionCount",
        label: "옵션",
        width: "80px",
        headerClassName: "justify-end",
        cellClassName: "flex items-center justify-end px-3 tabular-nums",
        render: (product) => product.optionCount,
        text: (product) => String(product.optionCount),
        sortValue: (product) => product.optionCount,
      },
      {
        key: "mappedOptionCount",
        label: "매핑",
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
        label: "주문",
        width: "90px",
        headerClassName: "justify-end",
        cellClassName: "flex items-center justify-end px-3 tabular-nums",
        render: (product) => product.orderItemCount,
        text: (product) => String(product.orderItemCount),
        sortValue: (product) => product.orderItemCount,
      },
      {
        key: "availableQuantity",
        label: "가용수량",
        width: "100px",
        headerClassName: "justify-end",
        cellClassName: "flex items-center justify-end px-3 tabular-nums",
        render: (product) => product.availableQuantity,
        text: (product) => String(product.availableQuantity),
        sortValue: (product) => product.availableQuantity,
      },
      {
        key: "updatedAt",
        label: "갱신",
        width: "140px",
        placeholder: "갱신일",
        cellClassName: "flex items-center px-3 text-xs",
        render: (product) => formatDate(product.updatedAt),
        text: (product) => product.updatedAt || "",
      },
    ],
    []
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
        label: "옵션",
        width: "minmax(220px,1fr)",
        placeholder: "옵션명",
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
        label: "상태",
        width: "90px",
        placeholder: "상태",
        cellClassName: "flex items-center px-3",
        render: (option) => statusBadge(option.mappingStatus),
        text: (option) => option.mappingStatus,
      },
      {
        key: "salesOfferCode",
        label: "판매 오퍼",
        width: "200px",
        placeholder: "오퍼",
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
        label: "용량",
        width: "90px",
        placeholder: "용량",
        cellClassName: "flex items-center px-3",
        render: (option) => option.requiredStorage || "-",
        text: (option) => option.requiredStorage || "",
      },
      {
        key: "requiredColor",
        label: "색상",
        width: "110px",
        placeholder: "색상",
        cellClassName: "flex items-center px-3",
        render: (option) => option.requiredColor || "-",
        text: (option) => option.requiredColor || "",
      },
      {
        key: "orderItemCount",
        label: "주문",
        width: "80px",
        headerClassName: "justify-end",
        cellClassName: "flex items-center justify-end px-3 tabular-nums",
        render: (option) => option.orderItemCount,
        text: (option) => String(option.orderItemCount),
        sortValue: (option) => option.orderItemCount,
      },
    ],
    []
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
        throw new Error(payload?.message || "채널 상품 목록을 불러오지 못했습니다.");
      }

      if (!payload.completeness?.complete) {
        throw new Error(
          "쿠팡 상품 목록 전체를 확인하지 못해 기존 목록을 유지합니다."
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
  }, []);

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
          <SummaryCell icon={Store} label="상품" value={products.length} />
          <SummaryCell icon={PackageSearch} label="옵션" value={totalOptionCount} />
          <SummaryCell icon={CheckCheck} label="매핑됨" value={mappedOptionCount} />
          <SummaryCell icon={ListChecks} label="미매핑" value={unmappedOptionCount} />
        </SummaryStrip>

        <WorkspacePanel className="flex-1">
          <PanelToolbar className="xl:grid-cols-[340px_160px_auto]">
            <SearchInput
              placeholder="상품명, 상품 ID, vendorItemId, 옵션명 검색"
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
                <SelectItem value="ALL">전체</SelectItem>
                <SelectItem value="MAPPED">전체 매핑됨</SelectItem>
                <SelectItem value="UNMAPPED">미매핑 포함</SelectItem>
              </SelectContent>
            </Select>

            <Button variant="outline" onClick={() => void loadData()}>
              <RefreshCcw className={cn("size-4", isLoading && "animate-spin")} />
              새로고침
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
                ? "채널 상품 목록을 불러오는 중입니다."
                : "표시할 채널 상품이 없습니다."
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
              {selectedProduct?.productName ?? "상품 선택"}
            </h2>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {selectedProduct?.externalProductId ?? "-"}
            </p>
          </div>
          <Badge variant="neutral" className="shrink-0">
            읽기 전용
          </Badge>
        </div>

        {selectedProduct ? (
          <>
            <div className="grid gap-3 border-b p-4">
              <div className="rounded-md border bg-background px-3 py-2">
                <DetailRow label="채널" value={selectedProduct.channel} />
                <DetailRow
                  label="상품 ID"
                  value={selectedProduct.externalProductId}
                />
                <DetailRow
                  label="옵션"
                  value={`${selectedProduct.optionCount}개`}
                />
                <DetailRow
                  label="매핑"
                  value={`${selectedProduct.mappedOptionCount}/${selectedProduct.optionCount}`}
                />
                <DetailRow
                  label="주문 아이템"
                  value={`${selectedProduct.orderItemCount}건`}
                />
                <DetailRow
                  label="가용 수량"
                  value={String(selectedProduct.availableQuantity)}
                />
                <DetailRow
                  label="마지막 주문"
                  value={formatDate(selectedProduct.lastOrderedAt)}
                />
                <DetailRow
                  label="최근 갱신"
                  value={formatDate(selectedProduct.updatedAt)}
                />
              </div>
            </div>

            <div className="min-h-0 flex-1">
              <VirtualizedDataGrid
                rows={selectedProduct.options}
                columns={optionColumns}
                rowKey={(option) => option.externalVendorItemId}
                emptyMessage="표시할 옵션이 없습니다."
                className="rounded-none border-0"
                minWidth="960px"
                rowHeight={58}
              />
            </div>
          </>
        ) : (
          <div className="grid min-h-80 place-items-center p-4 text-sm text-muted-foreground">
            상품을 선택하세요.
          </div>
        )}
      </aside>
    </MasterDetailLayout>
  );
}
