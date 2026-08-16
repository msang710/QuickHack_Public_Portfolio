export type CarrierApiMode = "mock" | "live";
export type CarrierOperationType = "READ" | "WRITE";
export type CarrierPayload = Record<string, unknown>;
export type CarrierRequestItem = Record<string, unknown>;

export type CarrierApiResult<T extends CarrierPayload = CarrierPayload> = {
  carrierCode: string;
  mode: CarrierApiMode;
  source: string;
  apiName: string;
  requestPath: string;
  method: "GET" | "POST";
  operationType: CarrierOperationType;
  httpStatusCode: number;
  requestHash: string | null;
  responseHash: string;
  rawPayloadText?: string;
  payload: T;
};

export type CarrierHtmlResult = Omit<CarrierApiResult, "payload"> & {
  html: string;
};

export interface CarrierClient {
  getContractInfo(customerCodes?: string[]): Promise<CarrierApiResult>;
  getContractFares(data: CarrierRequestItem[]): Promise<CarrierApiResult>;
  allocateTrackingNumbers(quantity: number): Promise<CarrierApiResult>;
  getPrintInfo(data: CarrierRequestItem[]): Promise<CarrierApiResult>;
  registerPrintedShipment(data: CarrierRequestItem): Promise<CarrierApiResult>;
  registerCarrierPrintOrders(data: CarrierRequestItem[]): Promise<CarrierApiResult>;
  getPrintedTrackingNumbers(data: CarrierRequestItem[]): Promise<CarrierApiResult>;
  getReturnPickupInfo(data: CarrierRequestItem[]): Promise<CarrierApiResult>;
  registerReturn(data: CarrierRequestItem[]): Promise<CarrierApiResult>;
  getReturnStatusByReceipt(data: CarrierRequestItem[]): Promise<CarrierApiResult>;
  getReturnStatusByOrder(data: CarrierRequestItem[]): Promise<CarrierApiResult>;
  getReturnInfoByOriginalTracking(data: CarrierRequestItem[]): Promise<CarrierApiResult>;
  getTracking(trackingNumbers: string[]): Promise<CarrierApiResult>;
  getLatestTracking(trackingNumbers: string[]): Promise<CarrierApiResult>;
  getExtraFare(data: CarrierRequestItem[]): Promise<CarrierApiResult>;
  getPrintPopupHtml(input: {
    customerCode?: string;
    takeDate: string;
  }): Promise<CarrierHtmlResult>;
}
