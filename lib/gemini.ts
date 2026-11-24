import {
  ApiError,
  GoogleGenAI,
  type GenerateContentParameters,
  type GenerateContentResponse,
} from '@google/genai';

// 'gemini-3.5-flash-lite' was removed: it is deprecated and its only effect
// was a wasted failing request on every generation.
const GENERATION_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash'];
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
