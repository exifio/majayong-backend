import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DeliveryService,
  InspectionBatchService,
  createInMemoryDeliveryRepository,
  type ContractItemEntity,
  type DeliveryContractInfo,
  type DeliveryEntity,
  type InspectionOpsPorts,
  type NotificationPorts,
} from "./index.ts";

describe("C-04: 자동 승인·이견 3택·기한 배치", () => {
  const baseTime = new Date("2026-11-10T10:00:00.000Z");
  const sevenDaysLater = new Date(baseTime.getTime() + 7 * 24 * 60 * 60 * 1000);

  function createTestSetup(options?: {
    settlementPort?: { approveInstallment(input: { contractId: string; installmentId: string }): Promise<unknown> };
    opsPorts?: InspectionOpsPorts;
  }) {
    const repo = createInMemoryDeliveryRepository();

    const contract: DeliveryContractInfo & {
      workDueAt: Date;
      depositDeadline: Date;
    } = {
      id: "contract-c04",
      clientUserId: "client-1",
      supplierUserId: "supplier-1",
      status: "ACTIVE",
      paymentStatus: "DEPOSITED",
      workDueAt: new Date("2026-12-16T10:00:00.000Z"),
      depositDeadline: new Date("2026-11-07T14:59:59.000Z"),
    };

    const installment = {
      id: "inst-1",
      contractId: contract.id,
      stage: "INTERIM" as const,
      status: "DELIVERED",
    };

    const item1: ContractItemEntity = {
      id: "item-1",
      contractId: contract.id,
      stage: "INTERIM",
      title: "기능 1",
      description: "기능 1 설명",
      conditions: [{ key: "c-1", text: "조건 1", state: "DECIDED" }],
      approvedAt: null,
      autoApproved: false,
    };

    const item2: ContractItemEntity = {
      id: "item-2",
      contractId: contract.id,
      stage: "INTERIM",
      title: "기능 2",
      description: "기능 2 설명",
      conditions: [{ key: "c-2", text: "조건 2", state: "DECIDED" }],
      approvedAt: null,
      autoApproved: false,
    };

    repo.seedContract(contract);
    repo.seedInstallment(installment);
    repo.seedContractItems([item1, item2]);

    const sentNotifications: Array<{ userId: string; type: string; targetId: string }> = [];
    const notificationPorts: NotificationPorts = {
      async createOnce(input: { userId: string; type: string; targetId: string }) {
        const key = `${input.userId}:${input.type}:${input.targetId}`;
        const exists = sentNotifications.some((n) => `${n.userId}:${n.type}:${n.targetId}` === key);
        if (!exists) {
          sentNotifications.push(input);
          return { created: true };
        }
        return { created: false };
      },
    };

    const batchService = new InspectionBatchService({
      repo,
      notificationPorts,
      clock: { now: () => baseTime },
      settlementPort: options?.settlementPort,
      opsPorts: options?.opsPorts,
    });

    const deliveryService = new DeliveryService({
      repo,
      clock: { now: () => baseTime },
      settlementPort: options?.settlementPort,
      opsPorts: options?.opsPorts,
    });

    return {
      repo,
      contract,
      installment,
      item1,
      item2,
      sentNotifications,
      batchService,
      deliveryService,
      notificationPorts,
    };
  }

  it("C-04-T01 7일 직전/정각/직후 시각 경계", async () => {
    // 준비: 검수 기한이 7일 뒤인 납품
    const { repo, installment, item1, batchService } = createTestSetup();

    const delivery = await repo.createDelivery({
      installmentId: installment.id,
      attemptNo: 1,
      items: [{ contractItemId: item1.id, links: [], files: [], howToCheck: "" }],
      summary: null,
      status: "SUBMITTED",
      submittedAt: baseTime,
      inspectionDueAt: sevenDaysLater,
      reviewedAt: null,
    });

    // 실행 및 확인: 1. 7일 직전 (1초 전) -> 자동 승인 0건
    const justBefore = new Date(sevenDaysLater.getTime() - 1000);
    const resBefore = await batchService.processAutoApproval(delivery.id, justBefore);
    assert.equal(resBefore.autoApprovedCount, 0);

    const itemBefore = await repo.getContractItem(item1.id);
    assert.equal(itemBefore?.approvedAt, null);

    // 실행 및 확인: 2. 기한 정각까지는 유효 -> 자동 승인 0건
    const resExact = await batchService.processAutoApproval(delivery.id, sevenDaysLater);
    assert.equal(resExact.autoApprovedCount, 0);

    // 실행 및 확인: 3. 기한을 넘긴 직후 -> 자동 승인 1건, 다시 실행하면 0건
    const justAfter = new Date(sevenDaysLater.getTime() + 1);
    const resAfter = await batchService.processAutoApproval(delivery.id, justAfter);
    assert.equal(resAfter.autoApprovedCount, 1);
    const itemExact = await repo.getContractItem(item1.id);
    assert.ok(itemExact?.approvedAt);
    assert.equal(itemExact.autoApproved, true);

    const resAgain = await batchService.processAutoApproval(delivery.id, new Date(sevenDaysLater.getTime() + 1000));
    assert.equal(resAgain.autoApprovedCount, 0);
  });

  it("C-04-T02 OPEN·ESCALATED·CANCEL_REQUESTED에서 승인·지급 0", async () => {
    // 준비: 두 항목 납품과 item1의 OPEN 보완 요청
    const { repo, contract, installment, item1, item2, batchService } = createTestSetup();

    const delivery = await repo.createDelivery({
      installmentId: installment.id,
      attemptNo: 1,
      items: [
        { contractItemId: item1.id, links: [], files: [], howToCheck: "" },
        { contractItemId: item2.id, links: [], files: [], howToCheck: "" },
      ],
      summary: null,
      status: "REWORK_REQUESTED",
      submittedAt: baseTime,
      inspectionDueAt: sevenDaysLater,
      reviewedAt: null,
    });

    await repo.createInspectionRequest({
      deliveryId: delivery.id,
      contractItemId: item1.id,
      reason: "NOT_WORKING",
      conditionKey: null,
      note: "미작동",
      status: "OPEN",
      escalatedAt: null,
      resolvedAt: null,
      createdAt: baseTime,
    });

    // 실행: 7일 경과 시점 배치 실행
    const res = await batchService.processAutoApproval(delivery.id, new Date(sevenDaysLater.getTime() + 1));
    // 확인: item1은 OPEN 보완이 걸려 있어 제외되고 item2만 자동 승인
    assert.equal(res.autoApprovedCount, 1); // item2만 자동 승인

    const checkItem1 = await repo.getContractItem(item1.id);
    assert.equal(checkItem1?.approvedAt, null); // item1은 승인되지 않음

    // 준비: 계약을 CANCEL_REQUESTED로 변경
    repo.seedContract({ ...contract, status: "CANCEL_REQUESTED" });
    // 실행 및 확인: 취소 요청 중에는 전 항목 자동 승인 0
    const resCancel = await batchService.processAutoApproval(delivery.id, sevenDaysLater);
    assert.equal(resCancel.autoApprovedCount, 0);
  });

  it("C-04-T03 부분 승인 유지", async () => {
    // 준비: item1은 이미 의뢰인이 직접 승인한 상태
    const { repo, installment, item1, item2, batchService } = createTestSetup();
    await repo.updateContractItem(item1.id, {
      approvedAt: baseTime,
      autoApproved: false,
    });

    const delivery = await repo.createDelivery({
      installmentId: installment.id,
      attemptNo: 1,
      items: [
        { contractItemId: item1.id, links: [], files: [], howToCheck: "" },
        { contractItemId: item2.id, links: [], files: [], howToCheck: "" },
      ],
      summary: null,
      status: "PARTIALLY_APPROVED",
      submittedAt: baseTime,
      inspectionDueAt: sevenDaysLater,
      reviewedAt: null,
    });

    // 실행: 7일 경과 배치 실행
    const res = await batchService.processAutoApproval(delivery.id, new Date(sevenDaysLater.getTime() + 1));
    // 확인: item2만 새로 자동 승인되고 item1의 직접 승인 속성은 유지됨
    assert.equal(res.autoApprovedCount, 1); // item2만 새로 자동 승인됨

    const item1After = await repo.getContractItem(item1.id);
    assert.equal(item1After?.autoApproved, false); // 기존 직접 승인 속성 유지
    assert.equal(item1After?.approvedAt?.getTime(), baseTime.getTime());

    const item2After = await repo.getContractItem(item2.id);
    assert.equal(item2After?.autoApproved, true);
  });

  it("C-04-T04 보완 3회 자동 개입", async () => {
    // 준비: 보완 요청이 걸린 납품과 동일 항목 보완 요청 3회 기록
    const { repo, installment, item1, batchService } = createTestSetup();

    const delivery = await repo.createDelivery({
      installmentId: installment.id,
      attemptNo: 1,
      items: [{ contractItemId: item1.id, links: [], files: [], howToCheck: "" }],
      summary: null,
      status: "REWORK_REQUESTED",
      submittedAt: baseTime,
      inspectionDueAt: sevenDaysLater,
      reviewedAt: null,
    });

    await repo.createInspectionRequest({
      deliveryId: delivery.id,
      contractItemId: item1.id,
      reason: "NOT_WORKING",
      conditionKey: null,
      status: "RESOLVED",
      escalatedAt: null,
      createdAt: baseTime,
    });
    await repo.createInspectionRequest({
      deliveryId: delivery.id,
      contractItemId: item1.id,
      reason: "NOT_WORKING",
      conditionKey: null,
      status: "RESOLVED",
      escalatedAt: null,
      createdAt: baseTime,
    });
    const req3 = await repo.createInspectionRequest({
      deliveryId: delivery.id,
      contractItemId: item1.id,
      reason: "NOT_WORKING",
      conditionKey: null,
      status: "OPEN",
      escalatedAt: null,
      createdAt: baseTime,
    });

    // 실행: 3회차 보완 요청에 대한 에스컬레이션 확인
    const escalated = await batchService.checkAndEscalateItem(item1.id, req3.id);

    // 확인: ESCALATED 상태와 에스컬레이션 기록
    assert.equal(escalated.status, "ESCALATED");
    assert.ok(escalated.escalatedAt);
    assert.ok(escalated.escalation);
  });

  it("C-04-T05 판정 3택 및 양쪽 문구 분리", async () => {
    // 준비: 에스컬레이션된 이견
    const { repo, installment, item1, batchService } = createTestSetup();

    const delivery = await repo.createDelivery({
      installmentId: installment.id,
      attemptNo: 1,
      items: [{ contractItemId: item1.id, links: [], files: [], howToCheck: "" }],
      summary: null,
      status: "REWORK_REQUESTED",
      submittedAt: baseTime,
      inspectionDueAt: sevenDaysLater,
      reviewedAt: null,
    });

    const inspReq = await repo.createInspectionRequest({
      deliveryId: delivery.id,
      contractItemId: item1.id,
      reason: "CONDITION_MISMATCH",
      conditionKey: "c-1",
      status: "ESCALATED",
      escalatedAt: baseTime,
      createdAt: baseTime,
    });

    // 실행: 운영자 판정 (UNDECIDED_CONDITION)
    const decided = await batchService.decideDispute({
      inspectionRequestId: inspReq.id,
      decision: "UNDECIDED_CONDITION",
      reason: "계약서에 정하지 않은 조건임이 확인됨",
      decisionNotes: {
        client: "해당 조건은 미정 조건이므로 검수 기준에서 제외하고 승인합니다.",
        supplier: "정하지 않은 조건으로 확인되어 해당 항목을 승인 처리합니다.",
      },
    });

    // 확인: 판정 결과와 양쪽 문구가 각각 저장됨
    assert.equal(decided.decision, "UNDECIDED_CONDITION");
    assert.equal(decided.status, "RESOLVED");
    assert.deepEqual(decided.decisionNotes, {
      client: "해당 조건은 미정 조건이므로 검수 기준에서 제외하고 승인합니다.",
      supplier: "정하지 않은 조건으로 확인되어 해당 항목을 승인 처리합니다.",
    });

    // 확인: UNDECIDED_CONDITION 판정 시 항목도 승인됨
    const itemAfter = await repo.getContractItem(item1.id);
    assert.ok(itemAfter?.approvedAt);
  });

  it("C-04-T05b 사유 없는 판정은 거부", async () => {
    // 준비: 에스컬레이션된 이견
    const { repo, installment, item1, batchService } = createTestSetup();

    const delivery = await repo.createDelivery({
      installmentId: installment.id,
      attemptNo: 1,
      items: [{ contractItemId: item1.id, links: [], files: [], howToCheck: "" }],
      summary: null,
      status: "REWORK_REQUESTED",
      submittedAt: baseTime,
      inspectionDueAt: sevenDaysLater,
      reviewedAt: null,
    });

    const inspReq = await repo.createInspectionRequest({
      deliveryId: delivery.id,
      contractItemId: item1.id,
      reason: "CONDITION_MISMATCH",
      conditionKey: "c-1",
      status: "ESCALATED",
      escalatedAt: baseTime,
      createdAt: baseTime,
    });

    // 실행 및 확인: 사유가 빈 판정은 거부
    await assert.rejects(
      () =>
        batchService.decideDispute({
          inspectionRequestId: inspReq.id,
          decision: "APPROVE",
          reason: "", // 사유 필수
          decisionNotes: { client: "승인 결정", supplier: "승인 결정" },
        }),
      /사유/,
    );
  });

  it("C-04-T06 중복/동시 배치 알림 1회", async () => {
    // 준비: 예치 전 계약 (DEPOSIT_DUE 대상)
    const { repo, contract, sentNotifications, batchService } = createTestSetup();
    repo.seedContract({ ...contract, paymentStatus: "PENDING" });

    // 실행: 예치 기한 1일 전 시점에 배치 2회 연속 실행
    const oneDayBefore = new Date(contract.depositDeadline.getTime() - 24 * 60 * 60 * 1000);
    await batchService.sendDueNotifications(contract.id, oneDayBefore);
    await batchService.sendDueNotifications(contract.id, oneDayBefore);

    // 확인: 정확히 1건의 DEPOSIT_DUE 알림만 생성
    const depositDueAlerts = sentNotifications.filter(
      (n) => n.userId === contract.clientUserId && n.type === "DEPOSIT_DUE",
    );
    assert.equal(depositDueAlerts.length, 1);
  });

  it("C-04-T07 작업 마감 지남은 저장 상태가 아닌 파생값", () => {
    // 준비: 작업 마감 시각과 검수 상태
    const { batchService } = createTestSetup();
    const workDueAt = new Date("2026-12-16T10:00:00.000Z");

    // 실행 및 확인: 마감 이전은 overdue 아님
    assert.equal(
      batchService.isWorkOverdue({
        workDueAt,
        finalStageStatus: "PENDING",
        now: new Date("2026-12-15T10:00:00.000Z"),
      }),
      false,
    );

    // 실행 및 확인: 마감 초과는 overdue
    assert.equal(
      batchService.isWorkOverdue({
        workDueAt,
        finalStageStatus: "PENDING",
        now: new Date("2026-12-17T10:00:00.000Z"),
      }),
      true,
    );

    // 실행 및 확인: 마감이 지났어도 최종 납품이 완료(DELIVERED/APPROVED)되었으면 overdue가 아님
    assert.equal(
      batchService.isWorkOverdue({
        workDueAt,
        finalStageStatus: "APPROVED",
        now: new Date("2026-12-17T10:00:00.000Z"),
      }),
      false,
    );
  });

  it("C-04-T08 이견 재개시 정상 검수 흐름", async () => {
    // 준비: 에스컬레이션된 이견
    const { repo, installment, item1, batchService } = createTestSetup();

    const delivery = await repo.createDelivery({
      installmentId: installment.id,
      attemptNo: 1,
      items: [{ contractItemId: item1.id, links: [], files: [], howToCheck: "" }],
      summary: null,
      status: "REWORK_REQUESTED",
      submittedAt: baseTime,
      inspectionDueAt: sevenDaysLater,
      reviewedAt: null,
    });

    const inspReq = await repo.createInspectionRequest({
      deliveryId: delivery.id,
      contractItemId: item1.id,
      reason: "CONDITION_MISMATCH",
      conditionKey: "c-1",
      status: "ESCALATED",
      escalatedAt: baseTime,
      createdAt: baseTime,
    });

    // 실행: REWORK_VALID 판정
    const decided = await batchService.decideDispute({
      inspectionRequestId: inspReq.id,
      decision: "REWORK_VALID",
      reason: "보완 요청이 정당합니다.",
      decisionNotes: { client: "공급자에게 보완을 지시했습니다.", supplier: "기능을 보완하여 다시 제출하세요." },
    });

    // 확인: 판정 결과는 OPEN(공급자 재납품 대기), 항목은 미승인 유지
    assert.equal(decided.decision, "REWORK_VALID");
    assert.equal(decided.status, "OPEN"); // 공급자 재납품 대기

    const item = await repo.getContractItem(item1.id);
    assert.equal(item?.approvedAt, null);
  });

  function itemPayload(contractItemId: string) {
    return { contractItemId, links: [`https://app/${contractItemId}`], files: [], howToCheck: "확인" };
  }

  it("C-04-F01 가장 최근 납품만 자동 승인 판단 기준이 됨", async () => {
    // 준비: 1회차 납품과 이전 회차 OPEN 보완 요청
    const { repo, installment, item1, item2, batchService } = createTestSetup();

    const d1 = await repo.createDelivery({
      installmentId: installment.id,
      attemptNo: 1,
      items: [itemPayload(item1.id), itemPayload(item2.id)],
      summary: null,
      status: "REWORK_REQUESTED",
      submittedAt: baseTime,
      inspectionDueAt: sevenDaysLater,
      reviewedAt: null,
    });
    // 이전 납품에 남아 있는 OPEN (재납품 후 해소되지 않은 레거시 상태)
    await repo.createInspectionRequest({
      deliveryId: d1.id,
      contractItemId: item1.id,
      reason: "NOT_WORKING",
      conditionKey: null,
      note: "이전 회차 미작동",
      status: "OPEN",
      escalatedAt: null,
      resolvedAt: null,
      createdAt: baseTime,
    });

    // 준비: 2회차(최신) 납품
    const d2Due = new Date(sevenDaysLater.getTime() + 7 * 24 * 60 * 60 * 1000);
    const d2 = await repo.createDelivery({
      installmentId: installment.id,
      attemptNo: 2,
      items: [itemPayload(item1.id), itemPayload(item2.id)],
      summary: null,
      status: "SUBMITTED",
      submittedAt: sevenDaysLater,
      inspectionDueAt: d2Due,
      reviewedAt: null,
    });

    // 실행 및 확인: 최신이 아닌 납품으로는 자동 승인하지 않는다.
    assert.equal(
      (await batchService.processAutoApproval(d1.id, new Date(sevenDaysLater.getTime() + 1000))).autoApprovedCount,
      0,
    );

    // 실행 및 확인: 최신 납품은 이전 회차 OPEN 때문에 막히지 않는다.
    const res = await batchService.processAutoApproval(d2.id, new Date(d2Due.getTime() + 1));
    assert.equal(res.autoApprovedCount, 2);

    // 준비: 운영자 판정 대기(ESCALATED) 이견이 걸린 납품
    const escalated = createTestSetup();
    const d3 = await escalated.repo.createDelivery({
      installmentId: escalated.installment.id,
      attemptNo: 1,
      items: [itemPayload(escalated.item1.id)],
      summary: null,
      status: "SUBMITTED",
      submittedAt: baseTime,
      inspectionDueAt: sevenDaysLater,
      reviewedAt: null,
    });
    await escalated.repo.createInspectionRequest({
      deliveryId: d3.id,
      contractItemId: escalated.item1.id,
      reason: "OTHER",
      conditionKey: null,
      note: "운영자 판정 대기",
      status: "ESCALATED",
      escalatedAt: baseTime,
      createdAt: baseTime,
    });
    // 실행 및 확인: ESCALATED 이견이 있으면 자동 승인 0
    assert.equal(
      (
        await escalated.batchService.processAutoApproval(d3.id, new Date(sevenDaysLater.getTime() + 1))
      ).autoApprovedCount,
      0,
    );
  });

  it("C-04-F02 세 번째 보완 요청은 자동으로 ESCALATED 처리됨", async () => {
    // 준비: 시스템 메시지·이벤트를 기록하는 포트와 납품
    const messages: Array<{ contractId: string; targetId: string; body: string }> = [];
    const events: Array<{ actionType: string; targetId: string }> = [];
    const setup = createTestSetup({
      opsPorts: {
        async createSystemMessage(input) {
          messages.push(input);
        },
        async recordEvent(input) {
          events.push(input);
        },
      },
    });
    const { repo, contract, installment, item1, deliveryService } = setup;
    const supplier = { userId: contract.supplierUserId, role: "SUPPLIER" };
    const client = { userId: contract.clientUserId, role: "CLIENT" };
    repo.seedInstallment({ ...installment, status: "PENDING" });

    // 실행: 납품 후 보완 요청과 재납품을 3회 반복
    let delivery = await deliveryService.submitDelivery(supplier, {
      installmentId: installment.id,
      items: [itemPayload(item1.id)],
    });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await deliveryService.requestRework(client, {
        deliveryId: delivery.id,
        contractItemId: item1.id,
        reason: "NOT_WORKING",
        note: `보완 요청 ${attempt}`,
      });
      if (attempt < 3) {
        delivery = await deliveryService.submitDelivery(supplier, {
          installmentId: installment.id,
          items: [itemPayload(item1.id)],
        });
      }
    }

    // 확인: 3회차 보완 요청이 ESCALATED 되고 시스템 메시지·이벤트가 1회만 기록됨
    const inspections = await repo.listInspectionRequestsByItem(item1.id);
    assert.equal(inspections.length, 3);
    const latest = inspections[inspections.length - 1];
    assert.equal(latest.status, "ESCALATED");
    assert.ok(latest.escalatedAt);
    assert.equal(messages.length, 1);
    assert.equal(events.filter((event) => event.actionType === "DISPUTE_ESCALATED").length, 1);
  });

  it("C-04-F02b 사용자 도움 요청 #087은 당사자만 가능하고 사유가 필수", async () => {
    // 준비: 납품과 보완 요청
    const messages: Array<{ body: string }> = [];
    const setup = createTestSetup({
      opsPorts: {
        async createSystemMessage(input) {
          messages.push(input);
        },
      },
    });
    const { repo, contract, installment, item1, deliveryService } = setup;
    const supplier = { userId: contract.supplierUserId, role: "SUPPLIER" };
    const client = { userId: contract.clientUserId, role: "CLIENT" };
    repo.seedInstallment({ ...installment, status: "PENDING" });

    const delivery = await deliveryService.submitDelivery(supplier, {
      installmentId: installment.id,
      items: [itemPayload(item1.id)],
    });
    await deliveryService.requestRework(client, {
      deliveryId: delivery.id,
      contractItemId: item1.id,
      reason: "MISSING_PART",
      note: "일부 누락",
    });
    const [rework] = await repo.listInspectionRequestsByItem(item1.id);

    // 실행 및 확인: 당사자가 아닌 사용자의 도움 요청은 거부
    await assert.rejects(
      () =>
        deliveryService.escalateInspection(
          { userId: "outsider", role: "CLIENT" },
          rework.id,
          { reason: "도움 요청", what: "확인 요청" },
        ),
      /당사자/,
    );
    // 실행 및 확인: 사유가 공백이면 거부
    await assert.rejects(
      () => deliveryService.escalateInspection(client, rework.id, { reason: "   ", what: "확인 요청" }),
      /사유/,
    );
  });

  it("C-04-F02c 정상 도움 요청은 에스컬레이션으로 전환", async () => {
    // 준비: 납품과 보완 요청
    const messages: Array<{ body: string }> = [];
    const setup = createTestSetup({
      opsPorts: {
        async createSystemMessage(input) {
          messages.push(input);
        },
      },
    });
    const { repo, contract, installment, item1, deliveryService } = setup;
    const supplier = { userId: contract.supplierUserId, role: "SUPPLIER" };
    const client = { userId: contract.clientUserId, role: "CLIENT" };
    repo.seedInstallment({ ...installment, status: "PENDING" });

    const delivery = await deliveryService.submitDelivery(supplier, {
      installmentId: installment.id,
      items: [itemPayload(item1.id)],
    });
    await deliveryService.requestRework(client, {
      deliveryId: delivery.id,
      contractItemId: item1.id,
      reason: "MISSING_PART",
      note: "일부 누락",
    });
    const [rework] = await repo.listInspectionRequestsByItem(item1.id);

    // 실행: 공급자가 도움 요청
    const escalated = await deliveryService.escalateInspection(supplier, rework.id, {
      reason: "운영자 도움 요청",
      what: "동일 기능이 반복해서 동작하지 않습니다.",
      claims: { client: "미작동", supplier: "로컬에서는 동작" },
    });

    // 확인: ESCALATED 전이, 에스컬레이션 기록, 시스템 메시지 1건
    assert.equal(escalated.status, "ESCALATED");
    assert.ok(escalated.escalation);
    assert.equal(messages.length, 1);
  });

  it("C-04-F03 기한 알림은 대상·중복·중단 조건을 지킴", async () => {
    // 준비: 기한 알림 공통 시간 단위
    const DAY = 24 * 60 * 60 * 1000;

    // 실행 및 확인: 예치 완료 뒤에는 DEPOSIT_DUE를 보내지 않는다.
    const deposited = createTestSetup();
    const depositDayBefore = new Date(deposited.contract.depositDeadline.getTime() - DAY);
    await deposited.batchService.sendDueNotifications(deposited.contract.id, depositDayBefore);
    assert.equal(
      deposited.sentNotifications.filter((n) => n.type === "DEPOSIT_DUE").length,
      0,
    );

    // 준비: 예치 전 계약
    const pendingDeposit = createTestSetup();
    pendingDeposit.repo.seedContract({ ...pendingDeposit.contract, paymentStatus: "PENDING" });
    // 실행 및 확인: 예치 전에는 1회만 보낸다.
    await pendingDeposit.batchService.sendDueNotifications(pendingDeposit.contract.id, depositDayBefore);
    await pendingDeposit.batchService.sendDueNotifications(pendingDeposit.contract.id, depositDayBefore);
    assert.equal(
      pendingDeposit.sentNotifications.filter((n) => n.type === "DEPOSIT_DUE").length,
      1,
    );

    // 준비: 검수 기한이 남은 납품
    const inspection = createTestSetup();
    const due = new Date(sevenDaysLater);
    await inspection.repo.createDelivery({
      installmentId: inspection.installment.id,
      attemptNo: 1,
      items: [itemPayload(inspection.item1.id)],
      summary: null,
      status: "SUBMITTED",
      submittedAt: baseTime,
      inspectionDueAt: due,
      reviewedAt: null,
    });
    // 실행 및 확인: 검수 기한 하루 전 의뢰인 알림 1회
    const inspectionDayBefore = new Date(due.getTime() - DAY);
    await inspection.batchService.sendDueNotifications(inspection.contract.id, inspectionDayBefore);
    await inspection.batchService.sendDueNotifications(inspection.contract.id, inspectionDayBefore);
    const inspectionAlerts = inspection.sentNotifications.filter((n) => n.type === "INSPECTION_DUE");
    assert.equal(inspectionAlerts.length, 1);
    assert.equal(inspectionAlerts[0].userId, inspection.contract.clientUserId);

    // 준비: 최종 구간이 아직 미완료인 계약
    const workPending = createTestSetup();
    workPending.repo.seedInstallment({
      id: "inst-final",
      contractId: workPending.contract.id,
      stage: "FINAL",
      status: "PENDING",
    });
    // 실행 및 확인: 최종 구간이 미완료면 WORK_DUE 1회
    const workDayBefore = new Date(workPending.contract.workDueAt.getTime() - DAY);
    await workPending.batchService.sendDueNotifications(workPending.contract.id, workDayBefore);
    assert.equal(
      workPending.sentNotifications.filter((n) => n.type === "WORK_DUE").length,
      1,
    );

    // 준비: 최종 구간이 완료된 계약
    const workDone = createTestSetup();
    workDone.repo.seedInstallment({
      id: "inst-final",
      contractId: workDone.contract.id,
      stage: "FINAL",
      status: "APPROVED",
    });
    // 실행 및 확인: 완료된 계약은 WORK_DUE·WORK_OVERDUE 0
    await workDone.batchService.sendDueNotifications(workDone.contract.id, workDayBefore);
    await workDone.batchService.sendDueNotifications(
      workDone.contract.id,
      new Date(workDone.contract.workDueAt.getTime() + DAY),
    );
    assert.equal(
      workDone.sentNotifications.filter((n) => n.type === "WORK_DUE" || n.type === "WORK_OVERDUE").length,
      0,
    );

    // 준비: 마감이 지난 미완료 계약
    const overdue = createTestSetup();
    overdue.repo.seedInstallment({
      id: "inst-final",
      contractId: overdue.contract.id,
      stage: "FINAL",
      status: "PENDING",
    });
    // 실행 및 확인: 마감 지남은 양쪽 1회씩(2건) 알림
    const afterDue = new Date(overdue.contract.workDueAt.getTime() + DAY);
    await overdue.batchService.sendDueNotifications(overdue.contract.id, afterDue);
    await overdue.batchService.sendDueNotifications(overdue.contract.id, afterDue);
    assert.equal(
      overdue.sentNotifications.filter((n) => n.type === "WORK_OVERDUE").length,
      2,
    );

    // 준비: 취소 요청 중 계약
    const cancelled = createTestSetup();
    cancelled.repo.seedContract({ ...cancelled.contract, status: "CANCEL_REQUESTED" });
    // 실행 및 확인: 취소 요청 중에는 어떤 기한 알림도 보내지 않는다.
    await cancelled.batchService.sendDueNotifications(
      cancelled.contract.id,
      new Date(cancelled.contract.workDueAt.getTime() + DAY),
    );
    assert.equal(cancelled.sentNotifications.length, 0);
  });

  it("C-04-F04 승인·판정이 정산·재납품·감사 기록으로 연결됨", async () => {
    // 준비: 정산 포트와 시스템 메시지·이벤트 포트
    const settlementCalls: Array<{ contractId: string; installmentId: string }> = [];
    const messages: Array<{ body: string }> = [];
    const events: Array<{ actionType: string }> = [];
    const settlementPort = {
      async approveInstallment(input: { contractId: string; installmentId: string }) {
        settlementCalls.push(input);
        return {};
      },
    };
    const opsPorts: InspectionOpsPorts = {
      async createSystemMessage(input) {
        messages.push(input);
      },
      async recordEvent(input) {
        events.push(input);
      },
    };

    // 실행: 직접 승인으로 전 항목을 승인
    const approved = createTestSetup({ settlementPort, opsPorts });
    const d1 = await approved.repo.createDelivery({
      installmentId: approved.installment.id,
      attemptNo: 1,
      items: [itemPayload(approved.item1.id), itemPayload(approved.item2.id)],
      summary: null,
      status: "SUBMITTED",
      submittedAt: baseTime,
      inspectionDueAt: sevenDaysLater,
      reviewedAt: null,
    });
    const client = { userId: approved.contract.clientUserId, role: "CLIENT" };
    await approved.deliveryService.approveItem(client, {
      contractItemId: approved.item1.id,
      deliveryId: d1.id,
    });
    await approved.deliveryService.approveItem(client, {
      contractItemId: approved.item2.id,
      deliveryId: d1.id,
    });
    // 확인: 정산 승인 요청 1건과 납품 APPROVED 전이
    assert.equal(settlementCalls.length, 1);
    assert.equal(settlementCalls[0].installmentId, approved.installment.id);
    assert.equal((await approved.repo.getDelivery(d1.id))?.status, "APPROVED");

    // 실행: REWORK_VALID 판정
    const rework = createTestSetup({ settlementPort, opsPorts });
    const d2 = await rework.repo.createDelivery({
      installmentId: rework.installment.id,
      attemptNo: 1,
      items: [itemPayload(rework.item1.id)],
      summary: null,
      status: "REWORK_REQUESTED",
      submittedAt: baseTime,
      inspectionDueAt: sevenDaysLater,
      reviewedAt: null,
    });
    const escalated = await rework.repo.createInspectionRequest({
      deliveryId: d2.id,
      contractItemId: rework.item1.id,
      reason: "CONDITION_MISMATCH",
      conditionKey: "c-1",
      status: "ESCALATED",
      escalatedAt: baseTime,
      createdAt: baseTime,
    });
    const decisionsBefore = messages.length;
    const reworkDecision = await rework.batchService.decideDispute({
      inspectionRequestId: escalated.id,
      decision: "REWORK_VALID",
      reason: "보완 요청이 정당합니다.",
      decisionNotes: { client: "보완 지시", supplier: "다시 제출" },
    });
    // 확인: 재납품 가능 상태로 되돌리고 감사 기록을 남긴다.
    assert.equal(reworkDecision.status, "OPEN");
    assert.equal((await rework.repo.getDelivery(d2.id))?.status, "REWORK_REQUESTED");
    assert.equal((await rework.repo.getInstallment(rework.installment.id))?.status, "REWORK_REQUESTED");
    assert.equal((await rework.repo.getContractItem(rework.item1.id))?.approvedAt, null);
    assert.ok(messages.length > decisionsBefore);
    assert.ok(events.some((event) => event.actionType === "DISPUTE_DECIDED"));

    // 준비: item2는 이미 승인된 상태의 이견
    const approving = createTestSetup({ settlementPort, opsPorts });
    await approving.repo.updateContractItem(approving.item2.id, { approvedAt: baseTime });
    const d3 = await approving.repo.createDelivery({
      installmentId: approving.installment.id,
      attemptNo: 1,
      items: [itemPayload(approving.item1.id)],
      summary: null,
      status: "REWORK_REQUESTED",
      submittedAt: baseTime,
      inspectionDueAt: sevenDaysLater,
      reviewedAt: null,
    });
    const escalated2 = await approving.repo.createInspectionRequest({
      deliveryId: d3.id,
      contractItemId: approving.item1.id,
      reason: "OTHER",
      conditionKey: null,
      status: "ESCALATED",
      escalatedAt: baseTime,
      createdAt: baseTime,
    });

    // 실행: APPROVE 판정
    const approveDecision = await approving.batchService.decideDispute({
      inspectionRequestId: escalated2.id,
      decision: "APPROVE",
      reason: "기능 확인됨",
      decisionNotes: { client: "승인", supplier: "승인" },
    });
    // 확인: 항목 승인과 정산 승인 요청까지 수행한다.
    assert.equal(approveDecision.status, "RESOLVED");
    assert.ok((await approving.repo.getContractItem(approving.item1.id))?.approvedAt);
    assert.equal(settlementCalls.length, 2);
    assert.ok(messages.some((message) => message.body.includes("승인")));
  });
});
