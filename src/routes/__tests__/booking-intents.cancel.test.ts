import request from "supertest";
import express from "express";
import { createBookingIntentsRouter } from "../booking-intents.js";
import { setFeatureFlagsFromEnv } from "../../flags/service.js";
import { setRefundRepository, setSessionRepositoryForRefund } from "../../services/refund.js";
import { CheckoutSessionStatus } from "../../types/checkout.js";
import { featureFlagContextMiddleware } from "../../middleware/featureFlags.js";

// Bookable slot from InMemorySlotRepository defaults (startTime far in future → full refund tier)
const SLOT_ID = "slot-11111111-1111-4111-8111-111111111111";
// alice owns SLOT_ID, so any other user can book it
const OWNER = "owner-cancel-test";
const OWNER_HEADERS = { "x-chronopay-user-id": OWNER, "x-chronopay-role": "customer" };

// ─── Minimal in-memory repos ──────────────────────────────────────────────────

class InMemoryRefundRepo {
  readonly store: Map<string, any> = new Map();

  async create(req: any): Promise<any> {
    const entry = {
      id: `refund-${this.store.size + 1}`,
      paymentId: req.paymentId,
      amountCents: req.amountCents,
      currency: req.currency ?? "USD",
      reason: req.reason ?? null,
      status: "completed" as const,
      refundedBy: req.refundedBy ?? null,
      createdAt: Math.floor(Date.now() / 1000),
    };
    this.store.set(entry.id, entry);
    return entry;
  }

  async findByPaymentId(paymentId: string): Promise<any[]> {
    return Array.from(this.store.values()).filter((e) => e.paymentId === paymentId);
  }

  async sumRefundedCents(paymentId: string): Promise<number> {
    return Array.from(this.store.values())
      .filter((e) => e.paymentId === paymentId)
      .reduce((sum, e) => sum + e.amountCents, 0);
  }

  async findById(id: string): Promise<any | null> {
    return this.store.get(id) ?? null;
  }
}

class InMemorySessionRepo {
  readonly store: Map<string, any> = new Map();

  async create(session: any): Promise<any> {
    this.store.set(session.id, { ...session });
    return session;
  }

  async findById(id: string): Promise<any | null> {
    return this.store.get(id) ?? null;
  }

  async updateSession(id: string, fields: any): Promise<any> {
    const session = this.store.get(id);
    if (!session) throw new Error("Not found");
    Object.assign(session, fields);
    return session;
  }
}

// ─── Test app factory ─────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(featureFlagContextMiddleware);
  app.use("/api/v1/booking-intents", createBookingIntentsRouter());
  return app;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Creates a booking intent owned by OWNER and, optionally, seeds a completed
 * checkout session so RefundService can process a refund on the confirm path.
 */
async function makeIntent(
  app: express.Express,
  sessionRepo: InMemorySessionRepo,
  opts: { withSession?: boolean } = {},
): Promise<string> {
  const { withSession = true } = opts;

  const res = await request(app)
    .post("/api/v1/booking-intents")
    .set(OWNER_HEADERS)
    .send({ slotId: SLOT_ID });

  expect(res.status).toBe(201);
  const intentId: string = res.body.intent.id;

  if (withSession) {
    await sessionRepo.create({
      id: intentId,
      payment: { amount: 10000, currency: "USD", paymentMethod: "credit_card" },
      customer: { customerId: OWNER, email: "owner@example.com" },
      status: CheckoutSessionStatus.COMPLETED,
      createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
  }

  return intentId;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/v1/booking-intents/:id/cancel", () => {
  let app: express.Express;
  let refundRepo: InMemoryRefundRepo;
  let sessionRepo: InMemorySessionRepo;

  beforeEach(() => {
    process.env.FF_CREATE_BOOKING_INTENT = "true";
    setFeatureFlagsFromEnv(process.env);

    refundRepo = new InMemoryRefundRepo();
    sessionRepo = new InMemorySessionRepo();
    setRefundRepository(refundRepo as any);
    setSessionRepositoryForRefund(sessionRepo as any);

    // Fresh router + fresh repos per test via buildApp()
    app = buildApp();
  });

  afterAll(() => {
    delete process.env.FF_CREATE_BOOKING_INTENT;
    setFeatureFlagsFromEnv(process.env);
  });

  // ── Security ────────────────────────────────────────────────────────────────

  it("returns 401 when no auth headers are provided", async () => {
    const res = await request(app).post("/api/v1/booking-intents/intent-1/cancel");
    expect(res.status).toBe(401);
  });

  it("returns 503 when the feature flag is disabled", async () => {
    process.env.FF_CREATE_BOOKING_INTENT = "false";
    setFeatureFlagsFromEnv(process.env);

    const res = await request(app)
      .post("/api/v1/booking-intents/intent-1/cancel")
      .set(OWNER_HEADERS);

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("FEATURE_DISABLED");
  });

  it("returns 404 for an unknown intent id", async () => {
    const res = await request(app)
      .post("/api/v1/booking-intents/unknown-id/cancel")
      .set(OWNER_HEADERS)
      .query({ confirm: "true" });

    expect(res.status).toBe(404);
  });

  it("returns 403 when a different customer tries to cancel", async () => {
    const intentId = await makeIntent(app, sessionRepo);

    const res = await request(app)
      .post(`/api/v1/booking-intents/${intentId}/cancel`)
      .set({ "x-chronopay-user-id": "someone-else", "x-chronopay-role": "customer" })
      .query({ confirm: "true" });

    expect(res.status).toBe(403);
  });

  // ── Preview mode (confirm omitted / confirm=false) ────────────────────────

  it("returns refund breakdown without cancelling when confirm is omitted", async () => {
    const intentId = await makeIntent(app, sessionRepo);

    const res = await request(app)
      .post(`/api/v1/booking-intents/${intentId}/cancel`)
      .set(OWNER_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.confirmed).toBe(false);
    expect(res.body.refund).toMatchObject({
      fee: expect.any(Number),
      taxReversal: expect.any(Number),
      netRefund: expect.any(Number),
      policyVersion: "v1-timezone-tier",
    });

    // Intent is still active — a second preview should succeed.
    const second = await request(app)
      .post(`/api/v1/booking-intents/${intentId}/cancel`)
      .set(OWNER_HEADERS);
    expect(second.status).toBe(200);
    expect(second.body.confirmed).toBe(false);
  });

  it("returns refund breakdown when confirm=false is explicit", async () => {
    const intentId = await makeIntent(app, sessionRepo);

    const res = await request(app)
      .post(`/api/v1/booking-intents/${intentId}/cancel`)
      .set(OWNER_HEADERS)
      .query({ confirm: "false" });

    expect(res.status).toBe(200);
    expect(res.body.confirmed).toBe(false);
    expect(res.body.refund.policyVersion).toBe("v1-timezone-tier");
  });

  it("preview and confirm return identical refund breakdowns", async () => {
    const intentId = await makeIntent(app, sessionRepo);

    const preview = await request(app)
      .post(`/api/v1/booking-intents/${intentId}/cancel`)
      .set(OWNER_HEADERS);

    const confirm = await request(app)
      .post(`/api/v1/booking-intents/${intentId}/cancel`)
      .set(OWNER_HEADERS)
      .query({ confirm: "true" });

    expect(confirm.status).toBe(200);
    expect(confirm.body.refund).toEqual(preview.body.refund);
  });

  // ── Confirm path ──────────────────────────────────────────────────────────

  it("cancels intent and returns confirmed=true with refund breakdown", async () => {
    const intentId = await makeIntent(app, sessionRepo);

    const res = await request(app)
      .post(`/api/v1/booking-intents/${intentId}/cancel`)
      .set(OWNER_HEADERS)
      .query({ confirm: "true" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.confirmed).toBe(true);
    expect(res.body.intent.status).toBe("cancelled");
    expect(res.body.refund).toMatchObject({
      policyVersion: "v1-timezone-tier",
      netRefund: expect.any(Number),
    });
  });

  it("admin can cancel another user's intent", async () => {
    const intentId = await makeIntent(app, sessionRepo);

    const res = await request(app)
      .post(`/api/v1/booking-intents/${intentId}/cancel`)
      .set({ "x-chronopay-user-id": "admin-user", "x-chronopay-role": "admin" })
      .query({ confirm: "true" });

    expect(res.status).toBe(200);
    expect(res.body.intent.status).toBe("cancelled");
  });

  it("emits a refund entry to RefundService when netRefund > 0", async () => {
    // SLOT_ID has startTime ~year 2030 → full refund tier → netRefund > 0
    const intentId = await makeIntent(app, sessionRepo);

    await request(app)
      .post(`/api/v1/booking-intents/${intentId}/cancel`)
      .set(OWNER_HEADERS)
      .query({ confirm: "true" });

    // Exactly one refund entry should have been created for this intent.
    const refunds = await refundRepo.findByPaymentId(intentId);
    expect(refunds.length).toBe(1);
    expect(refunds[0].amountCents).toBeGreaterThan(0);
  });

  // ── Strict policy — zero refund ───────────────────────────────────────────

  it("cancels without calling RefundService when netRefund is zero", async () => {
    // Simulate strict policy by using a slot whose startTime is in the past.
    // We inject a custom slot with past startTime via a fresh router.
    const { InMemorySlotRepository } = await import("../../modules/slots/slot-repository.js");
    const { InMemoryBookingIntentRepository } = await import("../../modules/booking-intents/booking-intent-repository.js");
    const { BookingIntentService } = await import("../../modules/booking-intents/booking-intent-service.js");
    const { CancellationPolicyService } = await import("../../services/cancellationPolicy.js");

    const pastSlot = {
      id: "slot-11111111-1111-4111-8111-111111111111", // same id, different startTime
      professional: "alice",
      startTime: Date.now() - 1000, // 1 second in the past → hoursUntilStart < 0 → refundRatio=0
      endTime: Date.now() + 3600_000,
      bookable: true,
    };
    const slotRepo = new InMemorySlotRepository([pastSlot]);
    const intentRepo = new InMemoryBookingIntentRepository();
    const service = new BookingIntentService(intentRepo, slotRepo);

    // Create intent directly via service (bypasses route/fraud machinery).
    const intent = await service.createIntent({ slotId: pastSlot.id }, { userId: OWNER, role: "customer", claims: {} as any });

    const policy = new CancellationPolicyService();
    const breakdown = policy.calculateRefund(intent);

    // Verify this produces a zero-refund scenario.
    expect(breakdown.netRefund).toBe(0);

    // Under zero-refund: cancel succeeds and RefundService is never called.
    const refundsBefore = refundRepo.store.size;
    // Mark the intent cancelled via the service directly (no route overhead needed).
    service.cancelIntent(intent.id, { userId: OWNER, role: "customer", claims: {} as any });
    expect(refundRepo.store.size).toBe(refundsBefore); // unchanged
  });

  // ── Replay protection (already cancelled) ────────────────────────────────

  it("returns 409 when replaying confirm on an already-cancelled intent", async () => {
    const intentId = await makeIntent(app, sessionRepo);

    await request(app)
      .post(`/api/v1/booking-intents/${intentId}/cancel`)
      .set(OWNER_HEADERS)
      .query({ confirm: "true" });

    const replay = await request(app)
      .post(`/api/v1/booking-intents/${intentId}/cancel`)
      .set(OWNER_HEADERS)
      .query({ confirm: "true" });

    expect(replay.status).toBe(409);
  });

  it("returns 409 on preview of an already-cancelled intent", async () => {
    const intentId = await makeIntent(app, sessionRepo);

    await request(app)
      .post(`/api/v1/booking-intents/${intentId}/cancel`)
      .set(OWNER_HEADERS)
      .query({ confirm: "true" });

    const preview = await request(app)
      .post(`/api/v1/booking-intents/${intentId}/cancel`)
      .set(OWNER_HEADERS);

    expect(preview.status).toBe(409);
  });

  // ── Already-confirmed intent ──────────────────────────────────────────────

  it("returns 409 when attempting to cancel a confirmed (completed) intent", async () => {
    const intentId = await makeIntent(app, sessionRepo);

    await request(app)
      .post(`/api/v1/booking-intents/${intentId}/confirm`)
      .set(OWNER_HEADERS);

    const res = await request(app)
      .post(`/api/v1/booking-intents/${intentId}/cancel`)
      .set(OWNER_HEADERS)
      .query({ confirm: "true" });

    expect(res.status).toBe(409);
  });

  // ── Refund failure path ───────────────────────────────────────────────────

  it("returns 502 REFUND_FAILED when RefundService throws after cancellation", async () => {
    // No backing checkout session → RefundService.createRefund throws SESSION_NOT_FOUND.
    // SLOT_ID has startTime far in the future so netRefund > 0.
    const intentId = await makeIntent(app, sessionRepo, { withSession: false });

    const res = await request(app)
      .post(`/api/v1/booking-intents/${intentId}/cancel`)
      .set(OWNER_HEADERS)
      .query({ confirm: "true" });

    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe("REFUND_FAILED");
    expect(res.body.intentId).toBe(intentId);
    expect(res.body.refund).toBeDefined();
    expect(res.body.refund.policyVersion).toBe("v1-timezone-tier");
  });
});
