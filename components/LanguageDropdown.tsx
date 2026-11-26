'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Globe } from 'lucide-react';
import type { Language } from '@/lib/translations';

// LANGUAGE DROPDOWN (2026-11-27): the three languages used to sit
// side-by-side as three small buttons in the header; now they live in
// one dropdown menu so the header stays compact on phones. The switching
// logic is unchanged (the parent's setLang), and no wording changed —
// the menu labels are the languages' own names (endonyms), so no new
// translation keys are needed. Works in RTL and LTR: the menu aligns
// to the button's end edge (end-0) and the items read text-start.
// The menu closes on outside click, on Escape (focus returns to the
// button), and after a language is picked; the button is keyboard
// reachable and ArrowDown opens the menu too.

const LANGUAGES: { code: Language; label: string }[] = [
  { code: 'ar', label: 'العربية' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'en', label: 'English' },
];

export default function LanguageDropdown({
  lang,
  onChange,
}: {
  lang: Language;
  onChange: (l: Language) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close on outside click / Escape while the menu is open.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open ]);

  const current = LANGUAGES.find((l) => l.code === lang) ?? LANGUAGES[0];

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1.5 bg-[#160b2e]/90 px-3 py-2 min-h-9 rounded-xl border border-purple-500/25 text-xs font-bold text-purple-100 hover:border-purple-400/50 transition cursor-pointer"
      >
        <Globe className="w-4 h-4 text-fuchsia-300" />
        <span>{current.label}</span>
        <ChevronDown
          className={`w-3.5 h-3.5 text-purple-300 transition-transform ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute end-0 top-full mt-2 min-w-40 z-50 overflow-hidden rounded-xl border border-purple-500/30 bg-[#160b2e] shadow-[0_10px_40px_rgba(0,0,0,0.6)] py-1"
        >
          {LANGUAGES.map((l) => (
            <button
              key={l.code}
              type="button"
              role="menuitemradio"
              aria-checked={lang === l.code}
              onClick={() => {
                onChange(l.code);
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between gap-2 px-3.5 py-2.5 min-h-9 text-sm font-semibold text-start transition cursor-pointer ${
                lang === l.code
                  ? 'bg-gradient-to-r from-purple-600/40 to-fuchsia-600/30 text-white'
                  : 'text-purple-100 hover:bg-purple-800/40'
              }`}
            >
              <span>{l.label}</span>
              {lang === l.code && <Check className="w-4 h-4 shrink-0 text-amber-400" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
