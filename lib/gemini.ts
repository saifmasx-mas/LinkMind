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

export async function generateContentWithFallback(
  ai: GoogleGenAI,
  request: Omit<GenerateContentParameters, 'model'>
): Promise<GenerateContentResponse> {
  let lastError: unknown;

  for (const model of GENERATION_MODELS) {
    try {
      return await ai.models.generateContent({
        ...request,
        model,
        config: {
          ...request.config,
          httpOptions: {
            ...request.config?.httpOptions,
            retryOptions: {
              attempts: 2,
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
      if (!(error instanceof ApiError) || !FALLBACK_STATUSES.has(error.status)) {
        throw error;
      }
      console.warn(`Gemini model ${model} unavailable (${error.status}); trying the next model.`);
    }
  }

  throw lastError ?? new Error('No Gemini models are available.');
}
