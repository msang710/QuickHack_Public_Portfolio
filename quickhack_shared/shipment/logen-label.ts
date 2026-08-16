export const LOGEN_LABEL_TEMPLATE = {
  code: "LOGEN_THERMAL_5IN_PREPRINTED",
  version: 1,
  widthMm: 100,
  lengthMm: 124,
  dotsPerMm: 8,
  widthDots: 800,
  lengthDots: 992,
  maxBatchSize: 30,
} as const;

export const LOGEN_LABEL_PRINT_STATUS = {
  notPrinted: "NOT_PRINTED",
  spooled: "SPOOLED",
  partial: "PARTIAL",
  confirmed: "CONFIRMED",
  failed: "FAILED",
  unknown: "UNKNOWN",
} as const;

export type LogenLabelPrintStatus =
  (typeof LOGEN_LABEL_PRINT_STATUS)[keyof typeof LOGEN_LABEL_PRINT_STATUS];

export type LogenLabelDto = {
  issueItemId: number;
  issueSequence: number;
  packageGroupId: number;
  trackingNumber: string;
  revisionNo: number;
  receiver: {
    name: string;
    phone: string;
    postCode: string;
    address1: string;
    address2: string;
    memo: string;
  };
  sender: {
    customerCode: string;
    name: string;
    tel: string;
    cell: string;
    postCode: string;
    address1: string;
    address2: string;
  };
  classification: {
    branchCode: string;
    dongName: string;
    classCode: string;
    zipCode: string;
    salesOfficeName: string;
    terminalName: string;
    branchShareYn: string;
  };
  parcel: {
    goodsName: string;
    goodsAmount: number;
    fareType: string;
    boxTypeCode: string;
    deliveryFare: number;
    extraFare: number;
    takeDate: string;
    packageMemberCount: number;
    pgNos: string[];
  };
};

export type LogenLabelBlocker = {
  code: string;
  message: string;
  issueItemId: number | null;
  issueSequence: number | null;
  packageGroupId: number | null;
};

