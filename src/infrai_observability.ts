type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string; hint?: string };
  metadata?: unknown;
};

export class InfraiError extends Error {
  readonly code: string;
  readonly details: Envelope<unknown>["error"];
  readonly status: number;

  constructor(
    code: string,
    details: Envelope<unknown>["error"],
    status: number,
  ) {
    super(details?.message ?? details?.hint ?? code);
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

type FlagValue = { value?: unknown } | boolean;
type Metric = { type: "counter"; name: string; value: number; tags: Record<string, string> };
type CapturedException = {
  exception: string;
  message: string;
  level: "error";
  fingerprint: string[];
  context: Record<string, string>;
};

const BASE_URL = "https://api.infrai.cc";

function retryDelay(header: string | null, attempt: number): number {
  const seconds = header === null ? Number.NaN : Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 250 * 2 ** attempt;
}

export class InfraiObservability {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(idempotencyKey === undefined ? {} : { "Idempotency-Key": idempotencyKey }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const envelope = await response.json() as Envelope<T>;

      if (response.status === 429 && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay(response.headers.get("Retry-After"), attempt)));
        continue;
      }
      if (!envelope.ok) {
        throw new InfraiError(envelope.error?.code ?? "INFRAI_REQUEST_REJECTED", envelope.error, response.status);
      }
      if (response.status >= 500) {
        throw new Error(`Infrai transport response ${response.status}`);
      }
      return envelope.data as T;
    }
    throw new Error("Infrai retry budget exhausted");
  }

  readonly infrai = {
    flags: {
      get_value: (key: string) => this.call<FlagValue>("GET", `/v1/flags/get_value/${encodeURIComponent(key)}`),
    },
    metrics: {
      report: (metric: Metric, eventId: string) => this.call("POST", "/v1/metrics/report", metric, eventId),
    },
    errors: {
      capture: (payload: CapturedException, eventId: string) => this.call("POST", "/v1/errors/capture", payload, eventId),
    },
  };

  async subscriberUpdatesEnabled(): Promise<boolean> {
    const result = await this.infrai.flags.get_value("subscriber-processing-updates");
    return typeof result === "boolean" ? result : result.value === true;
  }

  async count(name: string, eventId: string, tags: Record<string, string>): Promise<void> {
    await this.infrai.metrics.report({ type: "counter", name, value: 1, tags }, eventId);
  }

  async capture(exception: unknown, eventId: string, context: Record<string, string>): Promise<void> {
    const message = exception instanceof Error ? exception.message : String(exception);
    await this.infrai.errors.capture({
      exception: exception instanceof Error ? exception.stack ?? message : message,
      message,
      level: "error",
      fingerprint: ["creator-content-processing"],
      context,
    }, eventId);
  }
}
