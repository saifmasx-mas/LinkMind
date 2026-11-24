'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

// Cloudflare Turnstile (2026-11-24): the "are you a robot" check on the
// login page. Turnstile has no official React package, so this loads the
// official script (https://challenges.cloudflare.com/turnstile/v0/api.js)
// and renders the widget by hand. The site key is public; the secret key
// never leaves the server (see app/api/verify-turnstile/route.ts).

const TURNSTILE_SCRIPT_SRC =
  'https://challenges.cloudflare.com/turnstile/v0/api.js';

export interface TurnstileWidgetHandle {
  /** Show a fresh challenge and drop the current token. */
  reset: () => void;
}

interface TurnstileWidgetProps {
  siteKey: string;
  onVerify: (token: string) => void;
  onExpire?: () => void;
  onError?: () => void;
}

interface TurnstileApi {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      'expired-callback'?: () => void;
      'error-callback'?: () => void;
      theme?: 'light' | 'dark' | 'auto';
      size?: 'normal' | 'compact';
    }
  ) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId?: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const TurnstileWidget = forwardRef<TurnstileWidgetHandle, TurnstileWidgetProps>(
  function TurnstileWidget({ siteKey, onVerify, onExpire, onError }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const widgetIdRef = useRef<string | null>(null);
    // Callbacks change on every render; keep the latest in a ref so the
    // widget always calls the current ones without re-rendering itself.
    const callbacksRef = useRef({ onVerify, onExpire, onError });
    callbacksRef.current = { onVerify, onExpire, onError };

    useImperativeHandle(ref, () => ({
      reset: () => {
        if (widgetIdRef.current && window.turnstile) {
          window.turnstile.reset(widgetIdRef.current);
        }
      },
    }));

    useEffect(() => {
      let cancelled = false;

      const renderWidget = () => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        if (widgetIdRef.current) return;
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          callback: (token: string) => callbacksRef.current.onVerify(token),
          'expired-callback': () => callbacksRef.current.onExpire?.(),
          'error-callback': () => callbacksRef.current.onError?.(),
          // The login card is dark violet, so the dark widget fits the
          // page without changing any of the site's own colours.
          theme: 'dark',
          size: 'normal',
        });
      };

      if (window.turnstile) {
        renderWidget();
      } else {
        const existing = document.querySelector(
          `script[src="${TURNSTILE_SCRIPT_SRC}"]`
        );
        if (!existing) {
          const script = document.createElement('script');
          script.src = TURNSTILE_SCRIPT_SRC;
          script.async = true;
          script.defer = true;
          script.onload = renderWidget;
          script.onerror = () => callbacksRef.current.onError?.();
          document.head.appendChild(script);
        } else {
          existing.addEventListener('load', renderWidget, { once: true });
        }
      }

      return () => {
        cancelled = true;
        if (widgetIdRef.current && window.turnstile) {
          try {
            window.turnstile.remove(widgetIdRef.current);
          } catch {
            // The widget may already be gone (e.g. navigation); ignore.
          }
          widgetIdRef.current = null;
        }
      };
    }, [siteKey]);

    return <div ref={containerRef} aria-label="Cloudflare Turnstile" />;
  }
);

export default TurnstileWidget;
