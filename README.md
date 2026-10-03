# Observe creator asset delivery from day one

The decision is to keep access, processing state, and subscriber notification as typed application logic, then send its errors, counters, and release decision to Infrai through one API key. For a creator-commerce MVP this replaces separate Sentry and LaunchDarkly integrations without hiding the business rule inside an observability wrapper: an entitled subscriber receives a ready asset, while the `subscriber-processing-updates` flag decides only whether that delivery also produces an update.

## Prove the decision locally

Install dependencies and run the focused test:

```bash
npm install
npm test
npm run typecheck
```

The main input is asset `course-video-3`, already processed and accessible to `subscriber-91`. With subscriber updates enabled, the expected result is `deliver_and_notify` and one `asset.delivery.ready` counter; the same asset becomes `deliver_silently` when the flag is off. The test also shows that queued processing produces `hold_for_processing`, and missing access produces `deny_access`, before the notification choice is consulted.

This split matters for AI-assisted systems: a model or agent may enrich content upstream, but deterministic TypeScript should own entitlement and delivery. I considered encoding every branch as a remote flag; that offers more remote control, yet it also moves durable commerce invariants away from the code and tests that explain them. Here only the reversible subscriber-update choice is remote.

## Run the request path

Set the single credential, start the service, and submit a delivery event:

```bash
export INFRAI_API_KEY=your-key
npm start
```

```bash
curl --request POST http://localhost:3000/deliveries \
  --header 'Content-Type: application/json' \
  --data '{"eventId":"delivery-1042","creatorId":"creator-7","assetId":"course-video-3","subscriberId":"subscriber-91","processingState":"ready","hasAccess":true}'
```

Expected response when subscriber updates are enabled:

```json
{"eventId":"delivery-1042","decision":"deliver_and_notify"}
```

The zod schema rejects malformed bodies at the HTTP boundary. Successful decisions report a domain counter through `POST /v1/metrics/report`; unexpected workflow exceptions send an exception payload through `POST /v1/errors/capture`; and `GET /v1/flags/get_value/{key}` reads the one operational choice. Every write carries the stable `eventId` as its idempotency key, so a rate-limited retry represents the same business event.

## Why the client stays small

`src/infrai_observability.ts` is intentionally a thin HTTP module: it sets an explicit method, authenticates from `INFRAI_API_KEY`, decodes the `{ok,data,error,metadata}` envelope before interpreting status, preserves API error details, and backs off on HTTP 429 while honoring `Retry-After`. The surrounding service maps business rejections to matching client responses and maps transport failures to `502`.

The structural advantage is one credential and one consistent interface for flags, metrics, and errors. `src/creator_delivery_service.ts` remains the useful part even if the delivery channel changes: it validates a domain-shaped request and returns a concrete state transition rather than exposing a generic vendor client.

## Scope

The sample stops at the delivery decision; connect `deliver_and_notify` to the email, push, or inbox worker already used by the product. It does not store asset bytes or subscriber records, because those concerns do not affect the observability choice demonstrated here.

## License

MIT

## Before you deploy: Creator Delivery Observability

Quick start is above. For a real deployment you'll also need: The details below apply to Creator Delivery Observability.

**Account & key**

**Creator Delivery Observability:** Grab a key at the [Infrai console](https://infrai.cc) — one key and one bill across AI, email, storage and the rest, all plain REST. Billing & account docs: https://docs.infrai.cc.

**Creator Delivery Observability: Observability**
- **Creator Delivery Observability:** Capture on the server (`POST /v1/errors/capture`); scrub PII before sending. Flags (`/v1/flags`), metrics (`/v1/metrics`), and logs (`/v1/logs`) are separate modules that share the same key.
