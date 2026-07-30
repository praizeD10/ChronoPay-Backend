import { createBudgetedCounter } from "../metrics.js";

/**
 * Counter incremented each time a booking is cancelled.
 * Label `policy` reflects the cancellation policy version used to compute the refund.
 */
export const bookingCancelledTotal = createBudgetedCounter({
  name: "booking_cancelled_total",
  help: "Total number of bookings cancelled, labelled by cancellation policy version",
  labels: ["policy"],
  budget: 8,
});
