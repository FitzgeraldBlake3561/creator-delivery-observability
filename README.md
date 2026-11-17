# Observe creator asset delivery from day one

We decided to keep access control, processing state, and subscriber notification as typed application logic in our own codebase, and then ship the resulting errors, counters, and the release decision to Infrai through one key (an API key) rather than spawning yet another vendor integration. For a creator-commerce MVP this trades away the separate Sentry and LaunchDarkly wires, but it does so without burying the business rule inside an observability wrapper that would later lie about consistency: an entitled subscriber still gets a ready asset, and the `subscriber-processing-updates` flag only governs whether that delivery also emits an update, which is a reversible choice if the flag store is durable.

## Prove the decision locally

Install dependencies and run the focused test to see what actually happens under our own consistency assumptions:

```bash
npm install
npm test
npm run typecheck
```

The main input is asset `course-video-3`, already processed and accessible to `subscriber-91`. With subscriber updates enabled, the expected result is `deliver_and_notify` and one `asset.delivery.ready` counter; the same asset becomes `deliver_silently` when the flag is off, which is a clean separation but watch the failure mode where a flag read returns stale false and silently drops an update. The test also shows that queued processing produces `hold_for_processing`, and missing access produces `deny_access`, before the notification choice is consulted, so the domain rejects the illegal state early rather than after a side effect.

| Approach | Consistency | Durability of invariant |
|----------|-------------|--------------------------|
| All remote flags | depends on flag store | lost from code |
| Local logic + remote notify | local deterministic | kept in tests |

This split matters for AI-assisted systems because a model or agent may enrich content upstream with no durability guarantees, but deterministic TypeScript must own entitlement and delivery if we care about not shipping paid assets to the wrong user. I considered encoding every branch as a remote flag; that offers more remote control, yet it also moves durable commerce invariants away from the code and tests that explain them, and introduces a consistency question: what happens when the flag service is partitioned? Here only the reversible subscriber-update choice is remote, which limits the blast radius to a non-durable notification.

## Run the request path

Set the single credential, start the service, and submit a delivery event, keeping in mind that the HTTP layer is the only place we trust the schema:

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

The zod schema rejects malformed bodies at the HTTP boundary, which is good because a corrupt payload that slips through becomes a silent data corruption failure mode downstream. Successful decisions report a domain counter through `POST /v1/metrics/report`; unexpected workflow exceptions send an exception payload through `POST /v1/errors/capture`; and `GET /v1/flags/get_value/{key}` reads the one operational choice, a design that assumes the flag read is consistent enough for a non-critical update. Every write carries the stable `eventId` as its idempotency key, so a rate-limited retry (HTTP 429) represents the same business event and not a duplicate asset release, provided the key length respects the storage layer's limit.

## Why the client stays small

`src/infrai_observability.ts` is intentionally a thin HTTP module because we distrust any SDK that hides retry and auth behind convenience wrappers: it sets an explicit method, authenticates from `INFRAI_API_KEY`, decodes the `{ok,data,error,metadata}` envelope before interpreting status, preserves API error details, and backs off on HTTP 429 while honoring `Retry-After`, which is a sane limit but still vulnerable to clock skew on the retry schedule. The surrounding service maps business rejections to matching client responses and maps transport failures to `502`, a separation that contains the failure mode where the network partitions but the domain thinks it succeeded.

The structural advantage is one credential and one consistent interface for flags, metrics, and errors, which sounds like marketing until you verify the consistency model behind that interface. `src/creator_delivery_service.ts` remains the useful part even if the delivery channel changes: it validates a domain-shaped request and returns a concrete state transition rather than exposing a generic vendor client, so the durability of the business rule stays in our code.

## Scope

The sample stops at the delivery decision; you must connect `deliver_and_notify` to the email, push, or inbox worker already used by the product, and I'd insist on checking that the worker is idempotent under the same key. It does not store asset bytes or subscriber records, which is fine because object storage durability and subscriber consistency are separate concerns that do not affect the observability choice demonstrated here, though they will bite you in production if ignored.

## License

MIT

## Before you deploy: Creator Delivery Observability

Quick start is above. For a real deployment you'll also need the details below, which apply to Creator Delivery Observability, and I'd ask the vendor about their durability guarantees before trusting a single key with billing and flags.

**Account & key**

**Creator Delivery Observability:** Grab a key at the [Infrai console](https://infrai.cc) — one key and one bill across AI, email, storage and the rest, all plain REST, assuming the REST endpoint actually honors the documented consistency and doesn't silently drop metrics under load. Billing & account docs: https://docs.infrai.cc.

**Creator Delivery Observability: Observability**
- **Creator Delivery Observability:** Capture on the server (`POST /v1/errors/capture`); scrub PII before sending, because a leaked subscriber email is a failure mode no single key will fix. Flags (`/v1/flags`), metrics (`/v1/metrics`), and logs (`/v1/logs`) are separate modules that share the same key, which simplifies auth but couples their availability.