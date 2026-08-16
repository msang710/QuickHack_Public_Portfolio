import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { listCoupangProductOptions } = await import(
  "@/quickhack_server/sales-channel/coupang/product-mapping-service"
);

function listPayload(page, nextToken = null) {
  return {
    payload: {
      code: "SUCCESS",
      message: "OK",
      nextToken,
      data: [
        {
          sellerProductId: `PRODUCT-${page}`,
          sellerProductName: `상품 ${page}`,
          productId: `CATALOG-${page}`,
        },
      ],
    },
  };
}

function detailPayload(sellerProductId) {
  return {
    payload: {
      code: "SUCCESS",
      message: "OK",
      data: {
        sellerProductId,
        sellerProductName: sellerProductId,
        productId: `CATALOG-${sellerProductId}`,
        items: [
          {
            vendorItemId: `VENDOR-${sellerProductId}`,
            itemName: `옵션 ${sellerProductId}`,
            externalVendorSku: `QH_${sellerProductId}_BLACK_256_A`,
          },
        ],
      },
    },
  };
}

{
  const credentialContext = { marker: "single-context" };
  let openCount = 0;
  const observedContexts = [];
  const catalog = await listCoupangProductOptions({
    openCredentialContext: async () => {
      openCount += 1;
      return credentialContext;
    },
    getSellerProducts: async (input, context) => {
      observedContexts.push(context);
      const page = input.nextToken ? Number(input.nextToken) : 1;
      return listPayload(page, page < 21 ? String(page + 1) : null);
    },
    getSellerProduct: async (sellerProductId, context) => {
      observedContexts.push(context);
      return detailPayload(sellerProductId);
    },
  });

  assert.equal(openCount, 1);
  assert.equal(catalog.pageCount, 21);
  assert.equal(catalog.sellerProductCount, 21);
  assert.equal(catalog.optionCount, 21);
  assert.ok(observedContexts.every((context) => context === credentialContext));
}

await assert.rejects(
  () =>
    listCoupangProductOptions({
      openCredentialContext: async () => ({ marker: "repeat" }),
      getSellerProducts: async () => listPayload(1, "REPEATED"),
      getSellerProduct: async (sellerProductId) =>
        detailPayload(sellerProductId),
    }),
  (error) => error?.code === "COUPANG_CATALOG_PAGINATION_INCOMPLETE"
);

await assert.rejects(
  () =>
    listCoupangProductOptions({
      openCredentialContext: async () => ({ marker: "limit" }),
      maxPages: 2,
      getSellerProducts: async (input) => {
        const page = input.nextToken ? Number(input.nextToken) : 1;
        return listPayload(page, String(page + 1));
      },
      getSellerProduct: async (sellerProductId) =>
        detailPayload(sellerProductId),
    }),
  (error) => error?.code === "COUPANG_CATALOG_PAGE_LIMIT_EXCEEDED"
);

await assert.rejects(
  () =>
    listCoupangProductOptions({
      openCredentialContext: async () => ({ marker: "detail-failure" }),
      getSellerProducts: async () => listPayload(1),
      getSellerProduct: async () => {
        throw new Error("forced detail failure");
      },
    }),
  (error) => error?.code === "COUPANG_CATALOG_PRODUCT_DETAIL_FAILED"
);

{
  let detailCount = 0;
  const catalog = await listCoupangProductOptions({
    openCredentialContext: async () => ({ marker: "mixed" }),
    getSellerProducts: async () => ({
      payload: {
        data: {
          products: [
            {
              sellerProductId: "EMBEDDED-PRODUCT",
              productId: "EMBEDDED-CATALOG",
              sellerProductName: "embedded",
              vendorItemId: "EMBEDDED-VENDOR",
              sellerProductItemName: "embedded option",
            },
          ],
          sellerProducts: [
            {
              sellerProductId: "SUMMARY-PRODUCT",
              productId: "SUMMARY-CATALOG",
              sellerProductName: "summary",
            },
          ],
          nextToken: null,
        },
      },
    }),
    getSellerProduct: async (sellerProductId) => {
      detailCount += 1;
      return detailPayload(sellerProductId);
    },
  });
  assert.equal(detailCount, 1);
  assert.deepEqual(
    new Set(catalog.options.map((option) => option.vendorItemId)),
    new Set(["EMBEDDED-VENDOR", "VENDOR-SUMMARY-PRODUCT"])
  );
}

{
  const empty = await listCoupangProductOptions({
    openCredentialContext: async () => ({ marker: "empty" }),
    getSellerProducts: async () => ({
      payload: { code: "SUCCESS", message: "OK", nextToken: null, data: [] },
    }),
    getSellerProduct: async () => {
      throw new Error("empty catalog must not fetch details");
    },
  });
  assert.equal(empty.optionCount, 0);
  assert.equal(empty.sellerProductCount, 0);
}

console.log("Coupang channel product catalog completeness tests passed.");
