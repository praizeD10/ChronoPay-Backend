/**
 * @file src/routes/booking-intents.ts
 *
 * Express router for the /api/v1/booking-intents resource.
 *
 * POST /api/v1/booking-intents
 *   Creates a new booking intent with strict validation.
 *   Protected by feature flag FF_CREATE_BOOKING_INTENT.
 *   Requires JWT authentication via the Authorization Bearer token.
 */

import { Router, type Request, Response } from "express";
import { requireAuthenticatedActor } from "../middleware/auth.js";
import { requireFeatureFlag } from "../middleware/featureFlags.js";
import { auditMiddleware } from "../middleware/audit.js";
import { createAuthAwareRateLimiter } from "../middleware/rateLimiter.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import { payloadLimit, ROUTE_PAYLOAD_LIMITS } from "../middleware/payloadLimit.js";
import {
  BookingIntentService,
  BookingIntentError,
} from "../modules/booking-intents/booking-intent-service.js";
import { InMemoryBookingIntentRepository } from "../modules/booking-intents/booking-intent-repository.js";
import { InMemorySlotRepository } from "../modules/slots/slot-repository.js";
import { logger } from "../utils/logger.js";
import { recordFraudScore } from "../metrics/fraudDriftMetrics.js";
import { RefundService } from "../services/refund.js";
import { bookingCancelledTotal } from "../metrics/bookingMetrics.js";

export function createBookingIntentsRouter() {
  const router = Router();

  // ─── Repositories (replace with DB layer in production) ────────────────────
  const bookingIntentRepository = new InMemoryBookingIntentRepository();
  const slotRepository = new InMemorySlotRepository();
  const bookingIntentService = new BookingIntentService(bookingIntentRepository, slotRepository);

  function handleServiceError(error: unknown, res: Response): void {
    if (error instanceof BookingIntentError) {
      res.status(error.status).json({
        success: false,
        error: error.message,
        code: error.code,
      });
      return;
    }

    logger.error({ err: error }, "Unexpected error in booking intent operation");
    res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }

  const fraudScorer = new FraudScorer();

  router.post(
    "/",
    requireFeatureFlag("CREATE_BOOKING_INTENT"),
    requireAuthenticatedActor(["customer", "admin"]),
    ...payloadLimit(ROUTE_PAYLOAD_LIMITS.bookingIntent),
    idempotencyMiddleware,
    createAuthAwareRateLimiter(),
    auditMiddleware("CREATE_BOOKING_INTENT"),
    async (req: Request, res: Response): Promise<void> => {
      try {
        const input = req.body;
        const fraudResult = fraudScorer.evaluate(input.id ?? 'temp-intent-id', req);
        const threshold = fraudScorer.getThreshold();
        // Feed the live score into the fraud drift detector. The metrics
        // module is import-side-effect-free so a missing baseline is a no-op
        // rather than a request blocker. `FRAUD_MODEL_VERSION` threads the
        // histogram label through the deployment env (e.g. "2025-q1-r3").
        recordFraudScore(
          `v${process.env.FRAUD_MODEL_VERSION || 'default'}`,
          fraudResult.score,
        );
        if (fraudResult.score >= threshold) {
          const locale = (req.headers["accept-language"]?.split(",")[0].split("-")[0]) || "en";
          
          const publicCodes = Array.from(new Set(fraudResult.reasons.map((r: string) => getFraudReasonCode(r))));
          if (publicCodes.length === 0) publicCodes.push(FraudReasonCode.UNKNOWN_RISK);

          const errorPayload = {
            success: false,
            error: "Booking intent blocked due to security policies.",
            reasonCodes: publicCodes,
            messages: publicCodes.map((code: any) => getFraudMessage(code, locale as any))
          };

          if (fraudScorer.getStepUpMode() === 'challenge') {
            const challengeToken = crypto.randomUUID();
            return res.status(403).json({
              ...errorPayload,
              challengeRequired: true,
              challengeToken,
            });
          } else {
            const store = new QuarantineStore();
            const quarantineId = store.add({ input, actorId: (req as any).auth?.userId, fraudResult });
            return res.status(403).json({
              ...errorPayload,
              quarantineId,
            });
          }
        }
        if ((input as any).rrule) {
          const report = await bookingIntentService.createRecurringIntents(input as any, req.auth!);
          res.status(201).json({
            success: true,
            report,
          });
        } else {
          const intent = await bookingIntentService.createIntent(input as any, req.auth!);
          res.status(201).json({
            success: true,
            intent,
          });
        }
      } catch (error) {
        handleServiceError(error, res);
      }
    },
  );

  router.post(
    "/:id/confirm",
    requireFeatureFlag("CREATE_BOOKING_INTENT"),
    requireAuthenticatedActor(["customer", "admin"]),
    createAuthAwareRateLimiter(),
    auditMiddleware("CONFIRM_BOOKING_INTENT"),
    (req: Request, res: Response): void => {
      try {
        const intent = bookingIntentService.confirmIntent(req.params.id, req.auth!);
        res.status(200).json({
          success: true,
          intent,
        });
      } catch (error) {
        handleServiceError(error, res);
      }
    },
  );

  router.post(
    "/:id/cancel",
    requireFeatureFlag("CREATE_BOOKING_INTENT"),
    requireAuthenticatedActor(["customer", "admin"]),
    createAuthAwareRateLimiter(),
    auditMiddleware("CANCEL_BOOKING_INTENT"),
    async (req: Request, res: Response): Promise<void> => {
      try {
        const confirm = req.query.confirm === "true";

        // Always compute the refund preview first — it validates ownership + status.
        const breakdown = bookingIntentService.previewCancel(req.params.id, req.auth!);

        if (!confirm) {
          // Preview-only: return refund breakdown without mutating state.
          res.status(200).json({
            success: true,
            confirmed: false,
            refund: breakdown,
          });
          return;
        }

        // Confirm path: cancel the intent, issue refund, emit metric.
        const intent = bookingIntentService.cancelIntent(req.params.id, req.auth!);

        // Issue refund when there is a net amount to return.
        if (breakdown.netRefund > 0) {
          try {
            await RefundService.createRefund({
              paymentId: intent.id,
              amountCents: breakdown.netRefund,
              reason: `Booking ${intent.id} cancelled — policy ${breakdown.policyVersion}`,
              refundedBy: req.auth!.userId,
            });
          } catch (refundErr) {
            // Cancel already went through; log and surface refund failure to caller.
            logger.error({ err: refundErr, intentId: intent.id }, "Refund failed after booking cancellation");
            res.status(502).json({
              success: false,
              error: "Booking was cancelled but the refund could not be processed. Please contact support.",
              code: "REFUND_FAILED",
              intentId: intent.id,
              refund: breakdown,
            });
            return;
          }
        }

        bookingCancelledTotal.labels(breakdown.policyVersion).inc();

        res.status(200).json({
          success: true,
          confirmed: true,
          intent,
          refund: breakdown,
        });
      } catch (error) {
        handleServiceError(error, res);
      }
    },
  );

  router.get(
    "/:id/cancel-preview",
    requireFeatureFlag("CREATE_BOOKING_INTENT"),
    requireAuthenticatedActor(["customer", "admin"]),
    createAuthAwareRateLimiter(),
    (req: Request, res: Response): void => {
      try {
        const preview = bookingIntentService.previewCancel(req.params.id, req.auth!);
        res.status(200).json({
          success: true,
          preview,
        });
      } catch (error) {
        handleServiceError(error, res);
      }
    },
  );

  return router;
}

export default createBookingIntentsRouter();
