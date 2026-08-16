import {
  getCoupangOrdersheets,
  getCoupangReturnRequests,
  getCoupangSellerProducts,
} from "@/quickhack_server/sales-channel/coupang/api-client";

export type CoupangMockOrdersheetsInput = {
  status?: string;
  nextToken?: string | null;
  maxPerPage?: number;
};

export type CoupangMockReturnRequestsInput = {
  status?: string;
  maxPerPage?: number;
};

export type CoupangMockProductsInput = {
  limit?: number;
  search?: string;
};

export async function getMockOrdersheets(input: CoupangMockOrdersheetsInput) {
  return getCoupangOrdersheets({
    status: input.status,
    nextToken: input.nextToken,
    maxPerPage: input.maxPerPage,
  });
}

export async function getMockProducts(input: CoupangMockProductsInput = {}) {
  return getCoupangSellerProducts({
    maxPerPage: input.limit,
    sellerProductName: input.search,
  });
}

export async function getMockReturnRequests(
  input: CoupangMockReturnRequestsInput
) {
  return getCoupangReturnRequests({
    status: input.status,
    maxPerPage: input.maxPerPage,
  });
}
