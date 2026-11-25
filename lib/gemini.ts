import {
  ApiError,
  GoogleGenAI,
  type GenerateContentParameters,
  type GenerateContentResponse,
} from '@google/genai';

// SECURITY AUDIT (2026-11-24), low: the fallback 'gemini-3.6-flash' is the
// previous-generation Flash model. Google Cloud docs still list it as
// supported/Stable, but one lifecycle source claims an Agent Platform
// retirement date of 19 Nov 2026 (the Developer API used here lists no
// shutdown date). Verified 2026-11-24 via Google Cloud docs + model
// listings: 'gemini-3.5-flash-lite' is a real, documented, Stable model
// (Google's own advice for new projects alongside 3.8 Flash), so it is
// the third fallback — NOT an invented name. Re-check both fallback names
// in Google AI Studio before launch; the helper already skips a retired
// model on 404 and tries the next one.
const GENERATION_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'];
const FALLBACK_STATUSES = new Set([404, 408, 429, 500, 502, 503, 504]);

// FOLLOW-UP FIX (2026-11-25): the first version used a ~20s per-attempt
// timeout with SDK retry attempts: 2, so ONE slow model could burn the
// whole ~40s budget on its own (in production, gemini-3.8-flash took ~30s
// then returned 504, and both fallback models were aborted at ~42.6s
// without a real attempt). Per-attempt is now ~12s and the SDK does NOT
// retry (attempts: 1) — the model fallback chain IS the retry mechanism.
// Worst case the Gemini stage is min(3 x 12s, 40s) = ~36s, so all three
// models each get a real chance before the budget is spent.
// Per-attempt deadline, enforced by the SDK's abort timer (config.httpOptions
// .timeout, verified in @google/genai's genai.d.ts) and sent to the server
// as an X-Server-Timeout header.
const GENERATION_ATTEMPT_TIMEOUT_MS = 12_000;
// Overall wall-clock budget for the whole fallback chain, enforced with an
// AbortSignal passed as config.abortSignal (also verified in genai.d.ts).
// The SDK stops its own retries as soon as this signal aborts.
const GENERATION_TOTAL_BUDGET_MS = 40_000;

// The SDK's per-attempt abort timer surfaces a raw AbortError (a
// DOMException), not an ApiError, so the fallback check below must
// recognise it. Walk the cause chain because fetch may wrap it
// (e.g. "TypeError: fetch failed" caused by an AbortError).
function isTimeoutError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current != null; depth++) {
    if (typeof current !== 'object') return false;
    const name = (current as { name?: unknown }).name;
    if (name === 'AbortError' || name === 'TimeoutError') return true;
    const message = (current as { message?: unknown }).message;
    if (typeof message === 'string' && /abort|timed?\s*out/i.test(message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export async function generateContentWithFallback(
  ai: GoogleGenAI,
  request: Omit<GenerateContentParameters, 'model'>
): Promise<GenerateContentResponse> {
  let lastError: unknown;
  // AbortSignal.timeout needs no cleanup; aborting it ends the in-flight
  // request and stops the SDK's internal retries immediately.
  const overallSignal = AbortSignal.timeout(GENERATION_TOTAL_BUDGET_MS);

  for (const model of GENERATION_MODELS) {
    try {
      return await ai.models.generateContent({
        ...request,
        model,
        config: {
          ...request.config,
          // Overall budget for the whole fallback chain.
          abortSignal: overallSignal,
          httpOptions: {
            ...request.config?.httpOptions,
            // Per-attempt deadline: a hung socket fails at ~12s instead of
            // hanging until Vercel kills the request.
            timeout: GENERATION_ATTEMPT_TIMEOUT_MS,
            retryOptions: {
              // No SDK-level retry: the model fallback chain below IS the
              // retry mechanism. Retrying inside one slow model would eat
              // the overall budget before the next model is tried.
              attempts: 1,
              initialDelay: 1,
              maxDelay: 2,
              httpStatusCodes: [408, 429, 500, 502, 503, 504],
              ...request.config?.httpOptions?.retryOptions,
            },
          },
        },
      });
    } catch (error) {
      lastError = error;
      if (
        (error instanceof ApiError && FALLBACK_STATUSES.has(error.status)) ||
        isTimeoutError(error)
      ) {
        console.warn(
          `Gemini model ${model} unavailable (${
            error instanceof ApiError ? error.status : 'timeout'
          }); trying the next model.`
        );
        continue;
      }
      throw error;
    }
  }

  throw lastError ?? new Error('No Gemini models are available.');
}
