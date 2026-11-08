import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DeliveryService,
  DeliveryHttpError,
  InspectionBatchService,
  createInMemoryDeliveryRepository,
  type ContractItemEntity,
  type DeliveryContractInfo,
  type InspectionReason,
  type NotificationPorts,
} from "./index.ts";

describe("C-03: 항목별 납품·승인·보완 요청", () => {
  const baseTime = new Date("2026-11-10T10:00:00.000Z");

  // 준비: 예치 완료 계약, 구간, 계약 항목, 외부 계약 항목을 만들고 서비스를 연결한다.
  function createTestSetup() {
    const repo = createInMemoryDeliveryRepository();
    let now = baseTime;

    const contract: DeliveryContractInfo = {
      id: "contract-1",
      clientUserId: "client-1",
      supplierUserId: "supplier-1",
      status: "ACTIVE",
      paymentStatus: "DEPOSITED",
    };

    const installment = {
      id: "inst-interim-1",
      contractId: "contract-1",
      stage: "INTERIM" as const,
      status: "PENDING" as const,
    };

    const item1: ContractItemEntity = {
      id: "item-1",
      contractId: "contract-1",
      stage: "INTERIM",
      title: "예약 달력",
      description: "예약 달력 화면 구현",
      conditions: [
        { key: "cond-1", text: "10분 단위 선택", state: "DECIDED" },
        { key: "cond-2", text: "노쇼 표시 방식", state: "UNDECIDED" },
      ],
      approvedAt: null,
      autoApproved: false,
    };

    const item2: ContractItemEntity = {
      id: "item-2",
      contractId: "contract-1",
      stage: "INTERIM",
      title: "예약금 결제",
      description: "PG 결제 연동",
      conditions: [{ key: "cond-3", text: "카드 결제 영수증", state: "DECIDED" }],
      approvedAt: null,
      autoApproved: false,
    };

    const alienItem: ContractItemEntity = {
      id: "alien-item-99",
      contractId: "other-contract-99",
      stage: "INTERIM",
      title: "외부 계약 항목",
      description: "다른 계약 항목",
      conditions: [],
      approvedAt: null,
      autoApproved: false,
    };

    repo.seedContract(contract);
    repo.seedInstallment(installment);
    repo.seedContractItems([item1, item2, alienItem]);

    const service = new DeliveryService({
      repo,
      clock: { now: () => now },
    });

    return {
      repo,
      contract,
      installment,
      item1,
      item2,
      alienItem,
      service,
      setNow: (next: Date) => {
        now = next;
      },
    };
  }

  it("C-03-T01 타 계약 ID 삽입 차단", async () => {
    // 준비
    const { service, contract, installment, alienItem } = createTestSetup();

    // 실행 및 확인: 다른 계약의 항목 ID를 넣으면 400이다.
    await assert.rejects(
      () =>
        service.submitDelivery(
          { userId: contract.supplierUserId, role: "SUPPLIER" },
          {
            installmentId: installment.id,
            items: [
              {
                contractItemId: alienItem.id,
                links: ["https://github.com/ex/repo"],
                files: [],
                howToCheck: "확인 방법",
              },
            ],
            summary: "1회차 납품",
          },
        ),
      (err: unknown) => {
        if (!(err instanceof DeliveryHttpError)) return false;
        assert.equal(err.status, 400);
        assert.match(err.message, /계약 항목이 아닙니다/);
        return true;
      },
    );
  });

  it("C-03-T02 의뢰인이 납품을 제출하면 403", async () => {
    // 준비
    const { service, contract, installment, item1 } = createTestSetup();

    // 실행 및 확인
    await assert.rejects(
      () =>
        service.submitDelivery(
          { userId: contract.clientUserId, role: "CLIENT" },
          {
            installmentId: installment.id,
            items: [{ contractItemId: item1.id, links: [], files: [], howToCheck: "확인" }],
          },
        ),
      (err: unknown) => {
        if (!(err instanceof DeliveryHttpError)) return false;
        assert.equal(err.status, 403);
        assert.match(err.message, /공급자만/);
        return true;
      },
    );
  });

  it("C-03-T02c 공급자가 항목을 승인하면 403", async () => {
    // 준비
    const { service, contract, installment, item1 } = createTestSetup();
    const delivery = await service.submitDelivery(
      { userId: contract.supplierUserId, role: "SUPPLIER" },
      {
        installmentId: installment.id,
        items: [{ contractItemId: item1.id, links: ["https://preview.app"], files: [], howToCheck: "확인" }],
      },
    );

    // 실행 및 확인: 승인은 의뢰인만 가능하다.
    await assert.rejects(
      () =>
        service.approveItem(
          { userId: contract.supplierUserId, role: "SUPPLIER" },
          { contractItemId: item1.id, deliveryId: delivery.id },
        ),
      (err: unknown) => {
        if (!(err instanceof DeliveryHttpError)) return false;
        assert.equal(err.status, 403);
        assert.match(err.message, /의뢰인만/);
        return true;
      },
    );
  });

  it("C-03-T03 승인 항목 재검수 불가", async () => {
    // 준비
    const { service, contract, installment, item1 } = createTestSetup();
    const delivery = await service.submitDelivery(
      { userId: contract.supplierUserId, role: "SUPPLIER" },
      {
        installmentId: installment.id,
        items: [{ contractItemId: item1.id, links: ["https://preview.app"], files: [], howToCheck: "확인" }],
      },
    );
    const approved = await service.approveItem(
      { userId: contract.clientUserId, role: "CLIENT" },
      { contractItemId: item1.id, deliveryId: delivery.id },
    );
    assert.ok(approved.approvedAt);
    assert.equal(approved.autoApproved, false);

    // 실행 및 확인: 이미 승인된 항목의 보완 요청은 409다.
    await assert.rejects(
      () =>
        service.requestRework(
          { userId: contract.clientUserId, role: "CLIENT" },
          {
            deliveryId: delivery.id,
            contractItemId: item1.id,
            reason: "CONDITION_MISMATCH",
            conditionKey: "cond-1",
            note: "다시 해주세요",
          },
        ),
      (err: unknown) => {
        if (!(err instanceof DeliveryHttpError)) return false;
        assert.equal(err.status, 409);
        assert.match(err.message, /이미 승인된/);
        return true;
      },
    );
  });

  it("C-03-T04 미정(UNDECIDED) 조건만으로 보완 요청하면 422", async () => {
    // 준비
    const { service, contract, installment, item1 } = createTestSetup();
    const delivery = await service.submitDelivery(
      { userId: contract.supplierUserId, role: "SUPPLIER" },
      {
        installmentId: installment.id,
        items: [{ contractItemId: item1.id, links: ["https://preview.app"], files: [], howToCheck: "확인" }],
      },
    );

    // 실행 및 확인: cond-2는 UNDECIDED라 검수 기준이 아니다.
    await assert.rejects(
      () =>
        service.requestRework(
          { userId: contract.clientUserId, role: "CLIENT" },
          {
            deliveryId: delivery.id,
            contractItemId: item1.id,
            reason: "CONDITION_MISMATCH",
            conditionKey: "cond-2",
            note: "노쇼 표시 방식이 마음에 안 듯합니다.",
          },
        ),
      (err: unknown) => {
        if (!(err instanceof DeliveryHttpError)) return false;
        assert.equal(err.status, 422);
        assert.match(err.message, /DECIDED/);
        return true;
      },
    );
  });

  it("C-03-T04b 결정(DECIDED) 조건으로 보완 요청하면 허용", async () => {
    // 준비
    const { service, contract, installment, item1 } = createTestSetup();
    const delivery = await service.submitDelivery(
      { userId: contract.supplierUserId, role: "SUPPLIER" },
      {
        installmentId: installment.id,
        items: [{ contractItemId: item1.id, links: ["https://preview.app"], files: [], howToCheck: "확인" }],
      },
    );

    // 실행
    const rework = await service.requestRework(
      { userId: contract.clientUserId, role: "CLIENT" },
      {
        deliveryId: delivery.id,
        contractItemId: item1.id,
        reason: "CONDITION_MISMATCH",
        conditionKey: "cond-1",
        note: "10분 단위 선택이 동작하지 않습니다.",
      },
    );

    // 확인
    assert.equal(rework.status, "OPEN");
    assert.equal(rework.reason, "CONDITION_MISMATCH");
  });

  it("C-03-T05 7일 검사 기한", async () => {
    // 준비
    const { service, contract, installment, item1 } = createTestSetup();
    const delivery = await service.submitDelivery(
      { userId: contract.supplierUserId, role: "SUPPLIER" },
      {
        installmentId: installment.id,
        items: [{ contractItemId: item1.id, links: ["https://preview.app"], files: [], howToCheck: "확인" }],
      },
    );

    // 확인: 납품 시점부터 7일 뒤 KST 끝이다.
    assert.equal(delivery.inspectionDueAt.toISOString(), "2026-11-17T14:59:59.999Z");
  });

  it("C-03-T06 이미 승인된 항목을 다시 납품하면 400", async () => {
    // 준비: item1 승인, item2 보완 요청 상태를 만든다.
    const { service, contract, installment, item1, item2 } = createTestSetup();
    const d1 = await service.submitDelivery(
      { userId: contract.supplierUserId, role: "SUPPLIER" },
      {
        installmentId: installment.id,
        items: [
          { contractItemId: item1.id, links: ["https://app/1"], files: [], howToCheck: "확인1" },
          { contractItemId: item2.id, links: ["https://app/2"], files: [], howToCheck: "확인2" },
        ],
      },
    );
    assert.equal(d1.attemptNo, 1);
    await service.approveItem(
      { userId: contract.clientUserId, role: "CLIENT" },
      { contractItemId: item1.id, deliveryId: d1.id },
    );
    await service.requestRework(
      { userId: contract.clientUserId, role: "CLIENT" },
      {
        deliveryId: d1.id,
        contractItemId: item2.id,
        reason: "NOT_WORKING",
        note: "결제 모듈 에러",
      },
    );

    // 실행 및 확인: 이미 승인된 item1을 다시 넣으면 거부한다.
    await assert.rejects(
      () =>
        service.submitDelivery(
          { userId: contract.supplierUserId, role: "SUPPLIER" },
          {
            installmentId: installment.id,
            items: [
              { contractItemId: item1.id, links: ["https://app/1-again"], files: [], howToCheck: "재확인1" },
              { contractItemId: item2.id, links: ["https://app/2-fix"], files: [], howToCheck: "수정확인" },
            ],
          },
        ),
      (err: unknown) => {
        if (!(err instanceof DeliveryHttpError)) return false;
        assert.equal(err.status, 400);
        assert.match(err.message, /보완 요청된 미승인 항목만/);
        return true;
      },
    );
  });

  it("C-03-T06b 보완 요청된 항목만 재납품하면 2차 납품 성공", async () => {
    // 준비
    const { service, contract, installment, item1, item2 } = createTestSetup();
    const d1 = await service.submitDelivery(
      { userId: contract.supplierUserId, role: "SUPPLIER" },
      {
        installmentId: installment.id,
        items: [
          { contractItemId: item1.id, links: ["https://app/1"], files: [], howToCheck: "확인1" },
          { contractItemId: item2.id, links: ["https://app/2"], files: [], howToCheck: "확인2" },
        ],
      },
    );
    await service.approveItem(
      { userId: contract.clientUserId, role: "CLIENT" },
      { contractItemId: item1.id, deliveryId: d1.id },
    );
    await service.requestRework(
      { userId: contract.clientUserId, role: "CLIENT" },
      {
        deliveryId: d1.id,
        contractItemId: item2.id,
        reason: "NOT_WORKING",
        note: "결제 모듈 에러",
      },
    );

    // 실행
    const d2 = await service.submitDelivery(
      { userId: contract.supplierUserId, role: "SUPPLIER" },
      {
        installmentId: installment.id,
        items: [{ contractItemId: item2.id, links: ["https://app/2-fix"], files: [], howToCheck: "수정확인" }],
      },
    );

    // 확인
    assert.equal(d2.attemptNo, 2);
  });

  it("C-03-T07 JSON 파일 권한/크기 검증", async () => {
    // 준비
    const { service, contract, installment, item1 } = createTestSetup();

    // 실행 및 확인: 50MB를 넘는 파일은 400이다.
    await assert.rejects(
      () =>
        service.submitDelivery(
          { userId: contract.supplierUserId, role: "SUPPLIER" },
          {
            installmentId: installment.id,
            items: [
              {
                contractItemId: item1.id,
                links: [],
                files: [
                  {
                    fileId: "file-huge",
                    name: "huge_video.mp4",
                    size: 60 * 1024 * 1024,
                    mimeType: "video/mp4",
                  },
                ],
                howToCheck: "비디오 확인",
              },
            ],
          },
        ),
      (err: unknown) => {
        if (!(err instanceof DeliveryHttpError)) return false;
        assert.equal(err.status, 400);
        assert.match(err.message, /파일 크기/);
        return true;
      },
    );
  });

  it("C-03-T08 미완료 계약 납품 금지", async () => {
    // 준비: 예치 전(PENDING) 계약으로 바꾼다.
    const { service, contract, installment, item1, repo } = createTestSetup();
    repo.seedContract({
      ...contract,
      paymentStatus: "PENDING",
    });

    // 실행 및 확인
    await assert.rejects(
      () =>
        service.submitDelivery(
          { userId: contract.supplierUserId, role: "SUPPLIER" },
          {
            installmentId: installment.id,
            items: [{ contractItemId: item1.id, links: [], files: [], howToCheck: "확인" }],
          },
        ),
      (err: unknown) => {
        if (!(err instanceof DeliveryHttpError)) return false;
        assert.equal(err.status, 409);
        assert.match(err.message, /예치 완료된 계약만/);
        return true;
      },
    );
  });

  it("C-03-T02b 다른 납품 ID로 항목을 승인하지 않음", async () => {
    // 준비
    const { service, contract, installment, item1, repo } = createTestSetup();
    await service.submitDelivery(
      { userId: contract.supplierUserId, role: "SUPPLIER" },
      {
        installmentId: installment.id,
        items: [{ contractItemId: item1.id, links: ["https://preview.app"], files: [], howToCheck: "확인" }],
      },
    );
    const other = await repo.createDelivery({
      installmentId: installment.id,
      attemptNo: 9,
      items: [],
      summary: null,
      status: "SUBMITTED",
      submittedAt: baseTime,
      inspectionDueAt: new Date(baseTime.getTime() + 7 * 24 * 60 * 60 * 1000),
      reviewedAt: null,
    });

    // 실행 및 확인
    await assert.rejects(
      () =>
        service.approveItem(
          { userId: contract.clientUserId, role: "CLIENT" },
          { contractItemId: item1.id, deliveryId: other.id },
        ),
      (err: unknown) => {
        if (!(err instanceof DeliveryHttpError)) return false;
        assert.equal(err.status, 404);
        return true;
      },
    );

    // 확인: 항목은 승인되지 않았다.
    const item = await repo.getContractItem(item1.id);
    assert.equal(item?.approvedAt, null);
  });

  function payload(contractItemId: string) {
    return { contractItemId, links: [`https://app/${contractItemId}`], files: [], howToCheck: "확인" };
  }

  it("C-03-F01 납품·보완이 구간 상태 전이와 일치함", async () => {
    // 준비
    const { service, repo, contract, installment, item1, item2 } = createTestSetup();
    const supplier = { userId: contract.supplierUserId, role: "SUPPLIER" };
    const client = { userId: contract.clientUserId, role: "CLIENT" };

    // 실행: 1차 납품.
    const d1 = await service.submitDelivery(supplier, {
      installmentId: installment.id,
      items: [payload(item1.id), payload(item2.id)],
    });

    // 확인: 구간이 DELIVERED가 된다.
    assert.equal((await repo.getInstallment(installment.id))?.status, "DELIVERED");

    // 실행: item2 보완 요청.
    await service.requestRework(client, {
      deliveryId: d1.id,
      contractItemId: item2.id,
      reason: "NOT_WORKING",
      note: "결제 모듈 오류",
    });

    // 확인: 구간이 REWORK_REQUESTED가 된다.
    assert.equal((await repo.getInstallment(installment.id))?.status, "REWORK_REQUESTED");

    // 실행: item2만 재납품.
    await service.submitDelivery(supplier, {
      installmentId: installment.id,
      items: [payload(item2.id)],
    });

    // 확인: 다시 DELIVERED로 돌아온다.
    assert.equal((await repo.getInstallment(installment.id))?.status, "DELIVERED");

    // 실행 및 확인: 승인·지급이 끝난 구간에는 새 납품을 받지 않는다.
    repo.seedInstallment({ ...installment, status: "APPROVED" });
    await assert.rejects(
      () => service.submitDelivery(supplier, { installmentId: installment.id, items: [payload(item2.id)] }),
      (err: unknown) => err instanceof DeliveryHttpError && err.status === 409,
    );
  });

  it("C-03-F02 취소 요청 중 승인·보완은 실제 호출에서 차단됨", async () => {
    // 준비: 납품 뒤 계약을 CANCEL_REQUESTED로 바꾼다.
    const { service, repo, contract, installment, item1, item2 } = createTestSetup();
    const client = { userId: contract.clientUserId, role: "CLIENT" };
    const delivery = await service.submitDelivery(
      { userId: contract.supplierUserId, role: "SUPPLIER" },
      { installmentId: installment.id, items: [payload(item1.id), payload(item2.id)] },
    );
    repo.seedContract({ ...contract, status: "CANCEL_REQUESTED" });

    // 실행 및 확인: 승인은 409이고 항목은 승인되지 않는다.
    await assert.rejects(
      () => service.approveItem(client, { contractItemId: item1.id, deliveryId: delivery.id }),
      (err: unknown) => err instanceof DeliveryHttpError && err.status === 409,
    );
    assert.equal((await repo.getContractItem(item1.id))?.approvedAt, null);

    // 실행 및 확인: 보완 요청도 409이고 요청·납품 상태가 바뀌지 않는다.
    await assert.rejects(
      () =>
        service.requestRework(client, {
          deliveryId: delivery.id,
          contractItemId: item1.id,
          reason: "NOT_WORKING",
          note: "동작하지 않음",
        }),
      (err: unknown) => err instanceof DeliveryHttpError && err.status === 409,
    );
    assert.equal((await repo.listInspectionRequestsByItem(item1.id)).length, 0);
    assert.equal((await repo.getDelivery(delivery.id))?.status, "SUBMITTED");
  });

  it("C-03-F03 재납품이 이전 OPEN을 해소하고 검수 기한을 재설정함", async () => {
    // 준비
    const setup = createTestSetup();
    const { service, repo, contract, installment, item1, setNow } = setup;
    const supplier = { userId: contract.supplierUserId, role: "SUPPLIER" };
    const client = { userId: contract.clientUserId, role: "CLIENT" };

    // 실행: 1차 납품 후 보완 요청.
    const d1 = await service.submitDelivery(supplier, {
      installmentId: installment.id,
      items: [payload(item1.id)],
    });
    await service.requestRework(client, {
      deliveryId: d1.id,
      contractItemId: item1.id,
      reason: "MISSING_PART",
      note: "일부 화면 누락",
    });

    // 확인: OPEN 보완 요청이 1건이다.
    assert.equal(
      (await repo.listInspectionRequestsByItem(item1.id)).filter((row) => row.status === "OPEN").length,
      1,
    );

    // 실행: 시간을 옮기고 재납품한다.
    setNow(new Date("2026-11-12T10:00:00.000Z"));
    const d2 = await service.submitDelivery(supplier, {
      installmentId: installment.id,
      items: [payload(item1.id)],
    });

    // 확인: 검수 기한이 새 납품 시점 기준으로 다시 설정된다.
    assert.equal(d2.inspectionDueAt.toISOString(), "2026-11-19T14:59:59.999Z");

    // 확인: 이전 OPEN은 모두 RESOLVED가 된다.
    const inspections = await repo.listInspectionRequestsByItem(item1.id);
    assert.equal(inspections.filter((row) => row.status === "OPEN").length, 0);
    assert.ok(inspections.every((row) => row.status === "RESOLVED" && row.resolvedAt instanceof Date));
  });

  it("C-03-F03b 검수 기한이 지나도 자동 승인되지 않는다", async () => {
    // 준비: 재납품까지 마친 문맥.
    const setup = createTestSetup();
    const { service, repo, contract, installment, item1, setNow } = setup;
    const supplier = { userId: contract.supplierUserId, role: "SUPPLIER" };
    const client = { userId: contract.clientUserId, role: "CLIENT" };
    const d1 = await service.submitDelivery(supplier, {
      installmentId: installment.id,
      items: [payload(item1.id)],
    });
    await service.requestRework(client, {
      deliveryId: d1.id,
      contractItemId: item1.id,
      reason: "MISSING_PART",
      note: "일부 화면 누락",
    });
    setNow(new Date("2026-11-12T10:00:00.000Z"));
    const d2 = await service.submitDelivery(supplier, {
      installmentId: installment.id,
      items: [payload(item1.id)],
    });

    // 실행: 검수 기한이 지난 뒤 배치를 돌린다.
    const sent: string[] = [];
    const notificationPorts: NotificationPorts = {
      async createOnce(input) {
        sent.push(`${input.userId}:${input.type}:${input.targetId}`);
        return { created: true };
      },
    };
    const batch = new InspectionBatchService({ repo, notificationPorts });
    const result = await batch.processAutoApproval(d2.id, new Date("2026-11-19T15:00:00.000Z"));

    // 확인: 자동 승인하지 않고, 알림도 보내지 않는다(D-39).
    assert.equal(result.autoApprovedCount, 0);
    assert.equal((await repo.getContractItem(item1.id))?.approvedAt, null);
    assert.deepEqual(sent, []);
  });

  it("C-03-F04 보완 사유·조건·대상 항목 검증", async () => {
    // 준비
    const { service, contract, installment, item1, item2 } = createTestSetup();
    const supplier = { userId: contract.supplierUserId, role: "SUPPLIER" };
    const client = { userId: contract.clientUserId, role: "CLIENT" };
    const delivery = await service.submitDelivery(supplier, {
      installmentId: installment.id,
      items: [payload(item1.id)],
    });

    // 실행 및 확인: 잘못된 사유는 400이다.
    await assert.rejects(
      () =>
        service.requestRework(client, {
          deliveryId: delivery.id,
          contractItemId: item1.id,
          reason: "BOGUS" as InspectionReason,
          note: "이상한 사유",
        }),
      (err: unknown) => err instanceof DeliveryHttpError && err.status === 400,
    );

    // 실행 및 확인: 이 납품에 없는 항목은 404다.
    await assert.rejects(
      () =>
        service.requestRework(client, {
          deliveryId: delivery.id,
          contractItemId: item2.id,
          reason: "NOT_WORKING",
          note: "동작하지 않음",
        }),
      (err: unknown) => err instanceof DeliveryHttpError && err.status === 404,
    );

    // 실행 및 확인: 항목에 없는 조건 키는 422다.
    await assert.rejects(
      () =>
        service.requestRework(client, {
          deliveryId: delivery.id,
          contractItemId: item1.id,
          reason: "CONDITION_MISMATCH",
          conditionKey: "no-such-condition",
          note: "조건 불일치",
        }),
      (err: unknown) => err instanceof DeliveryHttpError && err.status === 422,
    );

    // 실행 및 확인: 설명이 공백이면 400이다.
    await assert.rejects(
      () =>
        service.requestRework(client, {
          deliveryId: delivery.id,
          contractItemId: item1.id,
          reason: "OTHER",
          note: "   ",
        }),
      (err: unknown) => err instanceof DeliveryHttpError && err.status === 400,
    );
  });

  it("C-03-F05 납품·보완 요청 조회는 계약 당사자만 가능", async () => {
    // 준비: 당사자와 외부 사용자, 보완 요청 1건을 만든다.
    const { service, repo, contract, installment, item1 } = createTestSetup();
    const supplier = { userId: contract.supplierUserId, role: "SUPPLIER" };
    const client = { userId: contract.clientUserId, role: "CLIENT" };
    const outsider = { userId: "outsider-9", role: "CLIENT" };
    const delivery = await service.submitDelivery(supplier, {
      installmentId: installment.id,
      items: [payload(item1.id)],
    });
    await service.requestRework(client, {
      deliveryId: delivery.id,
      contractItemId: item1.id,
      reason: "MISSING_PART",
      note: "일부 누락",
    });

    // 확인: 당사자는 목록을 볼 수 있다.
    assert.equal((await service.listDeliveries(client, installment.id)).length, 1);
    assert.equal((await service.listDeliveries(supplier, installment.id)).length, 1);

    // 실행 및 확인: 외부 사용자는 목록·상세·보완 목록 모두 403이다.
    await assert.rejects(
      () => service.listDeliveries(outsider, installment.id),
      (err: unknown) => err instanceof DeliveryHttpError && err.status === 403,
    );
    const detail = await service.getDelivery(client, delivery.id);
    assert.equal(detail.id, delivery.id);
    await assert.rejects(
      () => service.getDelivery(outsider, delivery.id),
      (err: unknown) => err instanceof DeliveryHttpError && err.status === 403,
    );
    const reworks = await service.listReworkRequests(supplier, item1.id);
    assert.equal(reworks.length, 1);
    await assert.rejects(
      () => service.listReworkRequests(outsider, item1.id),
      (err: unknown) => err instanceof DeliveryHttpError && err.status === 403,
    );

    // 실행 및 확인: 다른 계약의 구간은 같은 사용자라도 조회되지 않는다.
    repo.seedContract({
      id: "contract-2",
      clientUserId: "other-client",
      supplierUserId: "other-supplier",
      status: "ACTIVE",
      paymentStatus: "DEPOSITED",
    });
    repo.seedInstallment({ id: "inst-other", contractId: "contract-2", stage: "INTERIM", status: "DELIVERED" });
    await assert.rejects(
      () => service.listDeliveries(client, "inst-other"),
      (err: unknown) => err instanceof DeliveryHttpError && err.status === 403,
    );
  });

  it("C-03-T12 구간 승인 불가 시 항목 승인을 남기지 않는다", async () => {
    // 준비: 구간 승인 사전 검사가 실패하는 정산 포트
    const { repo, contract, installment, item1, item2 } = createTestSetup();
    const service = new DeliveryService({
      repo,
      clock: { now: () => baseTime },
      settlementPort: {
        async assertApprovable() {
          throw new DeliveryHttpError(400, "중간 구간이 먼저 지급되어야 합니다.");
        },
        async approveInstallment() {
          throw new Error("사전 검사 실패 시 구간 승인을 호출하면 안 된다");
        },
      },
    });
    const client = { userId: contract.clientUserId, role: "CLIENT" };
    const supplier = { userId: contract.supplierUserId, role: "SUPPLIER" };
    const delivery = await service.submitDelivery(supplier, {
      installmentId: installment.id,
      items: [
        { contractItemId: item1.id, links: [], files: [], howToCheck: "확인1" },
        { contractItemId: item2.id, links: [], files: [], howToCheck: "확인2" },
      ],
    });

    // 실행: 마지막 항목이 아닌 첫 항목은 정상 승인된다.
    await service.approveItem(client, { contractItemId: item1.id, deliveryId: delivery.id });

    // 실행 및 확인: 마지막 항목은 구간 승인 사전 검사에서 막혀 승인되지 않는다.
    await assert.rejects(
      () => service.approveItem(client, { contractItemId: item2.id, deliveryId: delivery.id }),
      (err: unknown) => err instanceof DeliveryHttpError && /중간 구간/.test(err.message),
    );
    assert.ok((await repo.getContractItem(item1.id))?.approvedAt);
    assert.equal((await repo.getContractItem(item2.id))?.approvedAt, null);
    assert.equal((await repo.getDelivery(delivery.id))?.status, "PARTIALLY_APPROVED");
  });
});
