import {
  acknowledgeCoupangOrdersheets,
  approveCoupangReturnRequest,
  confirmCoupangReturnReceived,
  stopCoupangReturnShipment,
  updateCoupangVendorItemQuantity,
  uploadCoupangInvoices,
  updateCoupangInvoices,
  type CoupangApiCredentialContext,
  type CoupangApiRequestOptions,
  type CoupangApiResponse,
} from "@/quickhack_server/sales-channel/coupang/api-client";
import {
  assertCoupangWriteAllowed,
} from "@/quickhack_server/sales-channel/coupang/config";
import { type SalesChannelWriteCommand } from "@/quickhack_shared/sales-channel/write-requests";

export const COUPANG_WRITE_ENDPOINTS = {
  ORDER_STATUS_INSTRUCT:
    "/v2/providers/openapi/apis/api/v4/vendors/{vendorId}/ordersheets/acknowledgement",
  COUPANG_INVOICE_UPLOAD:
    "/v2/providers/openapi/apis/api/v4/vendors/{vendorId}/orders/invoices",
  COUPANG_INVOICE_UPDATE:
    "/v2/providers/openapi/apis/api/v4/vendors/{vendorId}/orders/updateInvoices",
  RETURN_STOPPED_SHIPMENT:
    "/v2/providers/openapi/apis/api/v4/vendors/{vendorId}/returnRequests/{receiptId}/stoppedShipment",
  RETURN_RECEIVE_CONFIRMATION:
    "/v2/providers/openapi/apis/api/v4/vendors/{vendorId}/returnRequests/{receiptId}/receiveConfirmation",
  RETURN_APPROVAL:
    "/v2/providers/openapi/apis/api/v4/vendors/{vendorId}/returnRequests/{receiptId}/approval",
  COUPANG_INVENTORY_QUANTITY_UPDATE:
    "/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/{vendorItemId}/quantities/{quantity}",
} as const;

const COUPANG_WRITE_METHODS = {
  ORDER_STATUS_INSTRUCT: "PATCH",
  COUPANG_INVOICE_UPLOAD: "POST",
  COUPANG_INVOICE_UPDATE: "POST",
  RETURN_STOPPED_SHIPMENT: "PATCH",
  RETURN_RECEIVE_CONFIRMATION: "PATCH",
  RETURN_APPROVAL: "PATCH",
  COUPANG_INVENTORY_QUANTITY_UPDATE: "PUT",
} as const;

export function getSalesChannelWriteEndpoint(command: SalesChannelWriteCommand) {
  return {
    method: COUPANG_WRITE_METHODS[command.requestType],
    endpointPath: COUPANG_WRITE_ENDPOINTS[command.requestType],
    endpointKey: command.requestType,
  };
}

export function assertSalesChannelWriteAllowed(command: SalesChannelWriteCommand) {
  assertCoupangWriteAllowed(command.requestType);
}

export async function executeSalesChannelWriteAdapter(
  command: SalesChannelWriteCommand,
  credentialContext?: CoupangApiCredentialContext,
  options: CoupangApiRequestOptions = {}
): Promise<CoupangApiResponse<Record<string, unknown>>> {
  switch (command.requestType) {
    case "ORDER_STATUS_INSTRUCT":
      return acknowledgeCoupangOrdersheets(
        { shipmentBoxIds: command.shipmentBoxIds },
        credentialContext,
        options
      );
    case "COUPANG_INVOICE_UPLOAD":
      return uploadCoupangInvoices(
        { items: command.invoiceItems },
        credentialContext,
        options
      );
    case "COUPANG_INVOICE_UPDATE":
      return updateCoupangInvoices(
        { items: command.invoiceItems },
        credentialContext,
        options
      );
    case "RETURN_STOPPED_SHIPMENT":
      return stopCoupangReturnShipment(
        {
          receiptId: command.receiptId,
          cancelCount: command.cancelCount,
        },
        credentialContext,
        options
      );
    case "RETURN_RECEIVE_CONFIRMATION":
      return confirmCoupangReturnReceived(
        { receiptId: command.receiptId },
        credentialContext,
        options
      );
    case "RETURN_APPROVAL":
      return approveCoupangReturnRequest(
        {
          receiptId: command.receiptId,
          cancelCount: command.cancelCount,
        },
        credentialContext,
        options
      );
    case "COUPANG_INVENTORY_QUANTITY_UPDATE":
      return updateCoupangVendorItemQuantity(
        command.vendorItemId,
        command.expectedChannelQuantity,
        credentialContext,
        options
      );
  }
}
