import {
  assert,
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-personal-data-derived-redaction-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

const { prisma } = await import("../../../quickhack_server/core/prisma.ts");
const {
  recordPersonalDataDeliveryCompletion,
} = await import(
  "../../../quickhack_server/security/personal-data-lifecycle-service.ts"
);
const {
  redactExpiredSalesChannelPersonalData,
} = await import(
  "../../../quickhack_server/admin/privacy-maintenance-service.ts"
);
const {
  createDraftShipmentPackageGroups,
} = await import(
  "../../../quickhack_server/shipment/shipment-package-group-service.ts"
);
const {
  startCarrierInvoiceReplacement,
} = await import(
  "../../../quickhack_server/shipment/carrier-integration/coupang-invoice-replacement-service.ts"
);
const {
  registeredWorkers,
} = await import("../../../quickhack_server/workers/registry.ts");
const {
  addSeconds,
  quickHackClock,
} = await import("../../../quickhack_shared/core/time.ts");

function daysAgo(days) {
  return addSeconds(quickHackClock.nowDate(), -days * 24 * 60 * 60);
}

async function createSubject(
  externalOrderId,
  externalShipmentId,
  completionDaysAgo,
  options = {}
) {
  const timestamp = daysAgo(Math.max(completionDaysAgo, 1));
  const raw = await prisma.coupang_order_raw.create({
    data: {
      external_order_id: externalOrderId,
      external_shipment_id: externalShipmentId,
      external_order_status: "FINAL_DELIVERY",
      orderer_name: "주문자 홍길동",
      receiver_name: "수취인 김민지",
      receiver_safe_number: "050712345678",
      receiver_address_1: "서울특별시 예시구 테스트로 123",
      receiver_address_2: "퀵핵빌딩 4층",
      receiver_post_code: "01234",
      shipping_memo: "문 앞에 놓아주세요",
      synced_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  await prisma.$transaction((tx) =>
    recordPersonalDataDeliveryCompletion(tx, {
      externalOrderId,
      externalShipmentId,
      completedAt: daysAgo(completionDaysAgo),
      now: timestamp,
    })
  );
  if (options.legacyOrder) {
    await prisma.orders.create({
      data: {
        platform: "COUPANG",
        platform_order_id: externalOrderId,
        buyer_name: "구매자 박지수",
        receiver_name: "수취인 김민지",
        phone: "050712345678",
        shipping_address: "서울특별시 예시구 테스트로 123 예시건물 4층",
        shipping_memo: "문 앞에 놓아주세요",
        created_at: timestamp,
        updated_at: timestamp,
      },
    });
  }
  return raw;
}

async function createAddressChangeWork(
  externalOrderId,
  externalShipmentId,
  status
) {
  const timestamp = daysAgo(100);
  const event = await prisma.coupang_raw_change_event.create({
    data: {
      source_table: "coupang_order_raw",
      source_pk: `${externalOrderId}:${externalShipmentId}:${status}`,
      external_order_id: externalOrderId,
      external_shipment_id: externalShipmentId,
      event_type: "SHIPMENT_ADDRESS_CHANGED",
      change_hash: `address-${externalOrderId}-${status}`,
      process_status: "DONE",
      detected_at: timestamp,
      processed_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
      fields: {
        create: [
          {
            field_name: "receiver_name",
            before_value: "이전 수취인",
            after_value: "변경 수취인",
            created_at: timestamp,
          },
          {
            field_name: "receiver_address_1",
            before_value: "서울특별시 예시구 이전로 1",
            after_value: "서울특별시 예시구 변경로 2",
            created_at: timestamp,
          },
        ],
      },
    },
  });
  return prisma.shipment_address_change_work.create({
    data: {
      raw_change_event_id: event.coupang_raw_change_event_id,
      external_order_id: externalOrderId,
      external_shipment_id: externalShipmentId,
      change_status: status,
      detected_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
      fields: {
        create: [
          {
            field_name: "receiver_name",
            before_value: "이전 수취인",
            after_value: "변경 수취인",
            created_at: timestamp,
          },
          {
            field_name: "receiver_address_1",
            before_value: "서울특별시 예시구 이전로 1",
            after_value: "서울특별시 예시구 변경로 2",
            created_at: timestamp,
          },
        ],
      },
    },
  });
}

async function createClaimHistoryEvent(
  externalOrderId,
  externalShipmentId
) {
  const timestamp = daysAgo(100);
  return prisma.coupang_raw_change_event.create({
    data: {
      source_table: "coupang_return_raw",
      source_pk: `${externalOrderId}:claim`,
      external_order_id: externalOrderId,
      external_shipment_id: externalShipmentId,
      event_type: "RETURN_STATUS_CHANGED",
      change_hash: `claim-${externalOrderId}`,
      process_status: "DONE",
      detected_at: timestamp,
      processed_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
      fields: {
        create: {
          field_name: "receiver_name",
          before_value: "감사 근거 원문",
          after_value: "감사 근거 변경값",
          created_at: timestamp,
        },
      },
    },
    include: { fields: true },
  });
}

let allocationSequence = 0;

async function createAllocation(externalOrderId, externalShipmentId) {
  allocationSequence += 1;
  const pgNo = `PG-PII-${String(allocationSequence).padStart(3, "0")}`;
  await prisma.devices.create({
    data: {
      pg_no: pgNo,
      model: "SM-TEST",
      model_seq: allocationSequence,
    },
  });
  return prisma.match_worker_allocation.create({
    data: {
      external_order_id: externalOrderId,
      external_shipment_id: externalShipmentId,
      pg_no: pgNo,
      allocation_status: "CANCELED",
    },
    include: { order: true },
  });
}

async function createCompletedPackageGroup(subjects, options = {}) {
  const timestamp = daysAgo(100);
  const allocations = [];
  for (const subject of subjects) {
    allocations.push(
      await createAllocation(
        subject.externalOrderId,
        subject.externalShipmentId
      )
    );
  }
  const group = await prisma.shipment_package_groups.create({
    data: {
      channel: "COUPANG",
      grouping_key: `PII-GROUP-${allocationSequence}`,
      receiver_name_snapshot: "합포장 수취인",
      receiver_address_snapshot:
        "서울특별시 예시구 테스트로 123 예시건물 4층",
      receiver_phone_snapshot: "050712345678",
      receiver_post_code_snapshot: "01234",
      receiver_address_1_snapshot: "서울특별시 예시구 테스트로 123",
      receiver_address_2_snapshot: "퀵핵빌딩 4층",
      shipping_memo_snapshot: "문 앞에 놓아주세요",
      group_status: "COMPLETED",
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  await prisma.shipment_package_group_members.createMany({
    data: allocations.map((allocation, index) => ({
      package_group_id: group.package_group_id,
      allocation_id: allocation.allocation_id,
      external_order_id: allocation.external_order_id,
      external_shipment_id: allocation.external_shipment_id,
      member_sequence: index + 1,
      added_at: timestamp,
    })),
  });

  let replacementWork = null;
  if (options.replacementStatus) {
    const shipment = await prisma.carrier_shipments.create({
      data: {
        carrier_code: "LOGEN",
        channel: "COUPANG",
        package_group_id: group.package_group_id,
        tracking_number: `PII-${group.package_group_id}-OLD`,
        invoice_status: "REPLACED",
        shipment_status: "REGISTERED",
        created_at: timestamp,
        updated_at: timestamp,
      },
    });
    await prisma.shipment_package_groups.update({
      where: { package_group_id: group.package_group_id },
      data: { current_carrier_shipment_id: shipment.carrier_shipment_id },
    });
    replacementWork =
      await prisma.carrier_invoice_replacement_works.create({
        data: {
          source_type: "MANUAL",
          request_key: `PII-REPLACEMENT-${group.package_group_id}`,
          work_status: options.replacementStatus,
          current_stage: "FINALIZE",
          package_group_id: group.package_group_id,
          old_carrier_shipment_id: shipment.carrier_shipment_id,
          reason_code: "ADDRESS_CHANGED",
          before_receiver_name: "교체 전 수취인",
          before_receiver_phone: "050711112222",
          before_receiver_post_code: "01234",
          before_receiver_address_1: "서울특별시 예시구 이전로 1",
          before_receiver_address_2: "이전빌딩 1층",
          before_shipping_memo: "이전 배송메모",
          after_receiver_name: "교체 후 수취인",
          after_receiver_phone: "050733334444",
          after_receiver_post_code: "56789",
          after_receiver_address_1: "서울특별시 예시구 변경로 2",
          after_receiver_address_2: "변경빌딩 2층",
          after_shipping_memo: "변경 배송메모",
          requested_at: timestamp,
          created_at: timestamp,
          updated_at: timestamp,
        },
      });
  }

  return { allocations, group, replacementWork };
}

async function lifecycle(externalOrderId, externalShipmentId) {
  return prisma.sales_channel_personal_data_lifecycles.findUniqueOrThrow({
    where: {
      channel_external_order_id_external_shipment_id: {
        channel: "COUPANG",
        external_order_id: externalOrderId,
        external_shipment_id: externalShipmentId,
      },
    },
  });
}

try {
  await createSubject("ORDER-DIRECT", "SHIP-DIRECT", 120, {
    legacyOrder: true,
  });
  await createAddressChangeWork(
    "ORDER-DIRECT",
    "SHIP-DIRECT",
    "CONFIRMED"
  );
  const claimEvent = await createClaimHistoryEvent(
    "ORDER-DIRECT",
    "SHIP-DIRECT"
  );

  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION test_personal_data_redaction_rollback_fn()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'simulated derived-copy update failure';
    END;
    $$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER test_personal_data_redaction_rollback
    BEFORE UPDATE ON shipment_address_change_work_field
    FOR EACH ROW
    EXECUTE FUNCTION test_personal_data_redaction_rollback_fn()
  `);
  let rollbackObserved = false;
  try {
    await redactExpiredSalesChannelPersonalData();
  } catch {
    rollbackObserved = true;
  }
  const rolledBackRaw = await prisma.coupang_order_raw.findFirstOrThrow({
    where: { external_order_id: "ORDER-DIRECT" },
  });
  assert(
    rollbackObserved &&
      rolledBackRaw.receiver_name === "수취인 김민지" &&
      !(await lifecycle("ORDER-DIRECT", "SHIP-DIRECT")).redacted_at,
    "A derived-copy update failure did not roll back the subject transaction."
  );
  await prisma.$executeRawUnsafe(
    "DROP TRIGGER test_personal_data_redaction_rollback ON shipment_address_change_work_field"
  );
  await prisma.$executeRawUnsafe(
    "DROP FUNCTION test_personal_data_redaction_rollback_fn()"
  );

  const directRun = await redactExpiredSalesChannelPersonalData();
  const directRaw = await prisma.coupang_order_raw.findFirstOrThrow({
    where: { external_order_id: "ORDER-DIRECT" },
  });
  const directEventFields =
    await prisma.coupang_raw_change_event_field.findMany({
      where: {
        raw_change_event: {
          event_type: "SHIPMENT_ADDRESS_CHANGED",
          external_order_id: "ORDER-DIRECT",
        },
      },
    });
  const directWorkFields =
    await prisma.shipment_address_change_work_field.findMany({
      where: {
        shipment_address_change_work: {
          external_order_id: "ORDER-DIRECT",
        },
      },
    });
  const claimField =
    await prisma.coupang_raw_change_event_field.findUniqueOrThrow({
      where: {
        raw_change_event_id_field_name: {
          raw_change_event_id: claimEvent.coupang_raw_change_event_id,
          field_name: "receiver_name",
        },
      },
    });
  const legacyOrder = await prisma.orders.findFirstOrThrow({
    where: { platform_order_id: "ORDER-DIRECT" },
  });
  assert(
    directRaw.receiver_name !== "수취인 김민지" &&
      directRaw.receiver_safe_number.endsWith("5678") &&
      directRaw.receiver_post_code !== "01234",
    "The due raw order was not masked."
  );
  assert(
    directEventFields.every(
      (field) =>
        !field.before_value.includes("수취인") &&
        !field.after_value.includes("수취인") &&
        !field.before_value.includes("이전로") &&
        !field.after_value.includes("변경로")
    ),
    "Address-change event fields retained delivery PII."
  );
  assert(
    directWorkFields.every(
      (field) =>
        !field.before_value.includes("수취인") &&
        !field.after_value.includes("수취인") &&
        !field.before_value.includes("이전로") &&
        !field.after_value.includes("변경로")
    ),
    "Terminal address-change work fields retained delivery PII."
  );
  assert(
    claimField.before_value === "감사 근거 원문" &&
      claimField.after_value === "감사 근거 변경값",
    "A non-address claim-history event was modified."
  );
  assert(
    legacyOrder.receiver_name !== "수취인 김민지" &&
      legacyOrder.phone.endsWith("5678"),
    "The legacy order copy was not masked."
  );
  assert(
    Boolean((await lifecycle("ORDER-DIRECT", "SHIP-DIRECT")).redacted_at) &&
      directRun.completedSubjects >= 1 &&
      directRun.sanitizedCopies >= 4,
    "Derived-copy completion was not reflected in lifecycle or worker summary."
  );

  await createSubject("ORDER-ACTIVE-WORK", "SHIP-ACTIVE-WORK", 120);
  const activeWork = await createAddressChangeWork(
    "ORDER-ACTIVE-WORK",
    "SHIP-ACTIVE-WORK",
    "PENDING"
  );
  const activeRun = await redactExpiredSalesChannelPersonalData();
  const pendingField =
    await prisma.shipment_address_change_work_field.findFirstOrThrow({
      where: {
        shipment_address_change_work_id:
          activeWork.shipment_address_change_work_id,
        field_name: "receiver_name",
      },
    });
  assert(
    pendingField.before_value === "이전 수취인" &&
      !(await lifecycle("ORDER-ACTIVE-WORK", "SHIP-ACTIVE-WORK"))
        .redacted_at &&
      activeRun.deferredActiveWork >= 1,
    "A pending address-change work was not deferred."
  );
  await prisma.shipment_address_change_work.update({
    where: {
      shipment_address_change_work_id:
        activeWork.shipment_address_change_work_id,
    },
    data: {
      change_status: "CONFIRMED",
      confirmed_at: quickHackClock.nowDate(),
    },
  });
  await redactExpiredSalesChannelPersonalData();
  assert(
    Boolean(
      (await lifecycle("ORDER-ACTIVE-WORK", "SHIP-ACTIVE-WORK"))
        .redacted_at
    ),
    "A terminal address-change work did not release lifecycle completion."
  );

  await createSubject("ORDER-SHARED-DUE", "SHIP-SHARED-DUE", 120);
  await createSubject("ORDER-SHARED-RECENT", "SHIP-SHARED-RECENT", 20);
  const shared = await createCompletedPackageGroup([
    {
      externalOrderId: "ORDER-SHARED-DUE",
      externalShipmentId: "SHIP-SHARED-DUE",
    },
    {
      externalOrderId: "ORDER-SHARED-RECENT",
      externalShipmentId: "SHIP-SHARED-RECENT",
    },
  ]);
  const sharedRun = await redactExpiredSalesChannelPersonalData();
  const deferredGroup =
    await prisma.shipment_package_groups.findUniqueOrThrow({
      where: { package_group_id: shared.group.package_group_id },
    });
  assert(
    deferredGroup.receiver_name_snapshot === "합포장 수취인" &&
      !(await lifecycle("ORDER-SHARED-DUE", "SHIP-SHARED-DUE"))
        .redacted_at &&
      sharedRun.deferredSharedSubjects >= 1,
    "A shared group was not deferred while one member was still within retention."
  );
  const oldCompletion = daysAgo(120);
  await prisma.sales_channel_personal_data_lifecycles.update({
    where: {
      channel_external_order_id_external_shipment_id: {
        channel: "COUPANG",
        external_order_id: "ORDER-SHARED-RECENT",
        external_shipment_id: "SHIP-SHARED-RECENT",
      },
    },
    data: {
      delivery_completed_at: oldCompletion,
      retention_started_at: oldCompletion,
      updated_at: oldCompletion,
    },
  });
  await redactExpiredSalesChannelPersonalData();
  const completedGroup =
    await prisma.shipment_package_groups.findUniqueOrThrow({
      where: { package_group_id: shared.group.package_group_id },
    });
  assert(
    completedGroup.receiver_name_snapshot !== "합포장 수취인" &&
      completedGroup.receiver_post_code_snapshot !== "01234" &&
      Boolean(
        (await lifecycle("ORDER-SHARED-DUE", "SHIP-SHARED-DUE"))
          .redacted_at
      ) &&
      Boolean(
        (await lifecycle("ORDER-SHARED-RECENT", "SHIP-SHARED-RECENT"))
          .redacted_at
      ),
    "A fully due shared group did not complete."
  );

  await createSubject("ORDER-REPLACEMENT", "SHIP-REPLACEMENT", 120);
  const replacement = await createCompletedPackageGroup(
    [
      {
        externalOrderId: "ORDER-REPLACEMENT",
        externalShipmentId: "SHIP-REPLACEMENT",
      },
    ],
    { replacementStatus: "PROCESSING" }
  );
  const replacementDeferredRun =
    await redactExpiredSalesChannelPersonalData();
  assert(
    !(await lifecycle("ORDER-REPLACEMENT", "SHIP-REPLACEMENT"))
      .redacted_at &&
      replacementDeferredRun.deferredActiveWork >= 1,
    "An active invoice replacement did not defer PII completion."
  );
  await prisma.carrier_invoice_replacement_works.update({
    where: {
      carrier_invoice_replacement_work_id:
        replacement.replacementWork.carrier_invoice_replacement_work_id,
    },
    data: {
      work_status: "COMPLETED",
      completed_at: quickHackClock.nowDate(),
    },
  });
  await redactExpiredSalesChannelPersonalData();
  const redactedReplacement =
    await prisma.carrier_invoice_replacement_works.findUniqueOrThrow({
      where: {
        carrier_invoice_replacement_work_id:
          replacement.replacementWork.carrier_invoice_replacement_work_id,
      },
    });
  assert(
    redactedReplacement.before_receiver_name !== "교체 전 수취인" &&
      redactedReplacement.after_receiver_name !== "교체 후 수취인" &&
      redactedReplacement.before_receiver_post_code !== "01234" &&
      redactedReplacement.after_receiver_post_code !== "56789" &&
      Boolean(
        (await lifecycle("ORDER-REPLACEMENT", "SHIP-REPLACEMENT"))
          .redacted_at
      ),
    "Terminal invoice-replacement snapshots were not masked."
  );

  let creationBlocked = false;
  try {
    await prisma.$transaction((tx) =>
      createDraftShipmentPackageGroups(tx, {
        channel: "COUPANG",
        allocations: shared.allocations,
        createdAt: quickHackClock.nowDate(),
      })
    );
  } catch (error) {
    creationBlocked = String(error).includes("개인정보 보존기간");
  }
  assert(
    creationBlocked,
    "A due subject was allowed to create a new package-group snapshot."
  );

  await createSubject("ORDER-REPLACEMENT-GUARD", "SHIP-REPLACEMENT-GUARD", 120);
  const replacementGuard = await createCompletedPackageGroup([
    {
      externalOrderId: "ORDER-REPLACEMENT-GUARD",
      externalShipmentId: "SHIP-REPLACEMENT-GUARD",
    },
  ]);
  const guardAllocation = replacementGuard.allocations[0];
  await prisma.match_worker_allocation.update({
    where: { allocation_id: guardAllocation.allocation_id },
    data: { external_vendor_item_id: "VENDOR-REPLACEMENT-GUARD" },
  });
  await prisma.inventory.create({
    data: {
      pg_no: guardAllocation.pg_no,
      inventory_status: "DEPARTURE",
    },
  });
  const guardShipment = await prisma.carrier_shipments.create({
    data: {
      carrier_code: "LOGEN",
      channel: "COUPANG",
      package_group_id: replacementGuard.group.package_group_id,
      tracking_number: "PII-REPLACEMENT-GUARD-OLD",
      invoice_status: "ALLOCATED",
      shipment_status: "ALLOCATED",
    },
  });
  await prisma.shipment_package_groups.update({
    where: {
      package_group_id: replacementGuard.group.package_group_id,
    },
    data: {
      group_status: "READY",
      current_carrier_shipment_id: guardShipment.carrier_shipment_id,
    },
  });
  let replacementBlocked = false;
  let replacementFetchCount = 0;
  try {
    await startCarrierInvoiceReplacement(
      {
        packageGroupId: replacementGuard.group.package_group_id,
        sourceType: "MANUAL",
        reasonCode: "ADDRESS_CHANGED",
        reasonNote: "개인정보 보존기간 invariant 검사",
        userId: 1,
      },
      {
        credentialContext: {},
        getOrdersheetByOrderId: async () => {
          replacementFetchCount += 1;
          return {
            httpStatusCode: 200,
            payload: {
            code: "SUCCESS",
            message: "OK",
            data: [
              {
                orderId: "ORDER-REPLACEMENT-GUARD",
                shipmentBoxId: "SHIP-REPLACEMENT-GUARD",
                status: "DEPARTURE",
                orderedAt: daysAgo(130).toISOString(),
                receiver: {
                  name: "수취인 김민지",
                  safeNumber: "050712345678",
                  addr1: "서울특별시 예시구 테스트로 123",
                  addr2: "퀵핵빌딩 4층",
                  postCode: "01234",
                },
                parcelPrintMessage: "문 앞에 놓아주세요",
                deliveryCompanyName: "로젠택배",
                invoiceNumber: "PII-REPLACEMENT-GUARD-OLD",
                splitShipping: false,
                orderItems: [
                  {
                    vendorItemId: "VENDOR-REPLACEMENT-GUARD",
                    vendorItemName: "테스트 상품",
                    shippingCount: 1,
                    holdCountForCancel: 0,
                    cancelCount: 0,
                    canceled: false,
                  },
                ],
              },
            ],
            },
          };
        },
      }
    );
  } catch (error) {
    replacementBlocked =
      error?.code === "PERSONAL_DATA_RETENTION_EXPIRED";
  }
  assert(
    replacementBlocked,
    "A due subject was allowed to create an invoice-replacement snapshot."
  );
  assert(
    replacementFetchCount === 0,
    "A due subject triggered an external order lookup before retention rejection."
  );
  await prisma.shipment_package_groups.update({
    where: {
      package_group_id: replacementGuard.group.package_group_id,
    },
    data: { group_status: "COMPLETED" },
  });
  await redactExpiredSalesChannelPersonalData();

  const noOpRun = await redactExpiredSalesChannelPersonalData();
  assert(
    noOpRun.eligibleSubjects === 0 &&
      noOpRun.completedSubjects === 0 &&
      noOpRun.sanitizedCopies === 0,
    "A completed lifecycle was scanned again."
  );
  assert(
    registeredWorkers.some(
      (worker) => worker.key === "privacy-redact-expired-personal-data"
    ) &&
      !registeredWorkers.some(
        (worker) => worker.key === "privacy-redact-stored-raw-payloads"
      ),
    "The no-op privacy worker remains registered."
  );

  const dueIndex = await prisma.$queryRawUnsafe(`
    SELECT indexdef
    FROM pg_catalog.pg_indexes
    WHERE schemaname = current_schema()
      AND indexname = 'idx_sales_channel_personal_data_lifecycle_due'
  `);
  assert(
    /\(active_claim_count, redacted_at, retention_started_at\)/i.test(
      String(dueIndex[0]?.indexdef ?? "").replaceAll('"', "")
    ),
    "The lifecycle due index does not include the completion marker."
  );

  console.log("Derived personal-data redaction integration tests passed.");
} finally {
  await prisma.$disconnect();
  temporaryDatabase.cleanup();
}
