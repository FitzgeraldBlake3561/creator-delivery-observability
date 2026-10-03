import { createServer, type ServerResponse } from "node:http";
import { z } from "zod";
import { InfraiError, InfraiObservability } from "./infrai_observability.js";

export const deliveryRequestSchema = z.object({
  eventId: z.string().min(1),
  creatorId: z.string().min(1),
  assetId: z.string().min(1),
  subscriberId: z.string().min(1),
  processingState: z.enum(["queued", "ready", "failed"]),
  hasAccess: z.boolean(),
});

export type DeliveryRequest = z.infer<typeof deliveryRequestSchema>;
export type DeliveryDecision = "deliver_and_notify" | "deliver_silently" | "hold_for_processing" | "deny_access";

export interface ObservabilityPort {
  subscriberUpdatesEnabled(): Promise<boolean>;
  count(name: string, eventId: string, tags: Record<string, string>): Promise<void>;
  capture(exception: unknown, eventId: string, context: Record<string, string>): Promise<void>;
}

export async function decideDelivery(input: DeliveryRequest, telemetry: ObservabilityPort): Promise<DeliveryDecision> {
  const tags = { creator_id: input.creatorId, asset_id: input.assetId };
  if (!input.hasAccess) {
    await telemetry.count("asset.delivery.denied", input.eventId, tags);
    return "deny_access";
  }
  if (input.processingState !== "ready") {
    await telemetry.count("content.processing.pending", input.eventId, { ...tags, state: input.processingState });
    return "hold_for_processing";
  }

  const notify = await telemetry.subscriberUpdatesEnabled();
  await telemetry.count("asset.delivery.ready", input.eventId, { ...tags, subscriber_updates: String(notify) });
  return notify ? "deliver_and_notify" : "deliver_silently";
}

async function readJson(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

export function startService(telemetry: ObservabilityPort, port = 3000) {
  return createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/deliveries") {
      send(response, 404, { error: "route not found" });
      return;
    }
    let eventId = "unparsed-request";
    try {
      const input = deliveryRequestSchema.parse(await readJson(request));
      eventId = input.eventId;
      send(response, 200, { eventId, decision: await decideDelivery(input, telemetry) });
    } catch (error) {
      if (error instanceof z.ZodError) {
        send(response, 400, { error: "invalid request body", issues: error.issues });
        return;
      }
      if (error instanceof InfraiError) {
        send(response, error.status >= 400 && error.status < 500 ? error.status : 502, {
          error: { code: error.code, message: error.message },
        });
        return;
      }
      try {
        await telemetry.capture(error, `${eventId}:capture`, { workflow: "creator_delivery", event_id: eventId });
      } catch (captureError) {
        console.error(captureError);
      }
      send(response, 500, { error: "delivery processing failed" });
    }
  }).listen(port, () => console.log(`creator delivery service listening on http://localhost:${port}`));
}

if (process.argv[1]?.endsWith("creator_delivery_service.ts")) {
  const apiKey = process.env.INFRAI_API_KEY;
  if (!apiKey) throw new Error("INFRAI_API_KEY is required");
  startService(new InfraiObservability(apiKey));
}
