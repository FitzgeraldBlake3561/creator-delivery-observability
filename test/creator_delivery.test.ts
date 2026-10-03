import assert from "node:assert/strict";
import test from "node:test";
import { decideDelivery, deliveryRequestSchema, type ObservabilityPort } from "../src/creator_delivery_service.js";

class TelemetrySpy implements ObservabilityPort {
  metrics: string[] = [];
  private readonly updatesEnabled: boolean;

  constructor(updatesEnabled: boolean) {
    this.updatesEnabled = updatesEnabled;
  }
  async subscriberUpdatesEnabled() { return this.updatesEnabled; }
  async count(name: string) { this.metrics.push(name); }
  async capture() { throw new Error("capture is not expected in this decision test"); }
}

const readyDelivery = deliveryRequestSchema.parse({
  eventId: "delivery-1042",
  creatorId: "creator-7",
  assetId: "course-video-3",
  subscriberId: "subscriber-91",
  processingState: "ready",
  hasAccess: true,
});

test("a ready entitled asset follows the subscriber-update flag", async () => {
  const updatesOn = new TelemetrySpy(true);
  assert.equal(await decideDelivery(readyDelivery, updatesOn), "deliver_and_notify");
  assert.deepEqual(updatesOn.metrics, ["asset.delivery.ready"]);

  const updatesOff = new TelemetrySpy(false);
  assert.equal(await decideDelivery(readyDelivery, updatesOff), "deliver_silently");
});

test("processing and access gates take precedence over notification", async () => {
  const telemetry = new TelemetrySpy(true);
  assert.equal(await decideDelivery({ ...readyDelivery, processingState: "queued" }, telemetry), "hold_for_processing");
  assert.equal(await decideDelivery({ ...readyDelivery, hasAccess: false }, telemetry), "deny_access");
  assert.deepEqual(telemetry.metrics, ["content.processing.pending", "asset.delivery.denied"]);
});
