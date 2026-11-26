// Smoke test for the language dropdown (components/LanguageDropdown.tsx).
//
// Run: node scripts/smoke-language-dropdown.mjs
//
// No network needed. The dropdown is a React component, so this test
// asserts on the source that wires the behaviour the user asked for
// (2026-11-27 01:42): one dropdown instead of three side-by-side
// buttons, listing العربية / Türkçe / English, switching language with
// the same setLang logic, closing on outside click / Escape / pick,
// keyboard reachable, and used in both places the old buttons lived
// (main header in app/page.tsx, admin header in
// app/admin/signups/page.tsx). The real behaviour is also covered by
// `npm run lint` (tsc) and `next build`.

import { readFileSync } from 'node:fs';

let failures = 0;
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failures += 1;
}

const component = readFileSync('components/LanguageDropdown.tsx', 'utf8');
const mainPage = readFileSync('app/page.tsx', 'utf8');
const adminPage = readFileSync('app/admin/signups/page.tsx', 'utf8');

// 1. All three languages, named by their own names (endonyms).
check('lists العربية', component.includes("label: 'العربية'"));
check('lists Türkçe', component.includes("label: 'Türkçe'"));
check('lists English', component.includes("label: 'English'"));

// 2. Trigger button: globe icon + current language + chevron, with
//    menu semantics for assistive tech.
check('trigger shows Globe icon', component.includes('<Globe '));
check('trigger shows ChevronDown', component.includes('<ChevronDown'));
check('trigger has aria-haspopup="menu"', component.includes('aria-haspopup="menu"'));
check('trigger has aria-expanded', component.includes('aria-expanded={open}'));

// 3. Menu closes on outside click, on Escape (focus returns to the
//    button), and after a language is picked.
check('outside click closes (pointerdown + contains check)',
  component.includes("addEventListener('pointerdown'") &&
  component.includes('!rootRef.current.contains(e.target as Node)'));
check('Escape closes and returns focus to the button',
  component.includes("e.key === 'Escape'") &&
  component.includes('buttonRef.current?.focus()'));
check('picking a language closes the menu',
  component.includes('onChange(l.code);') && component.includes('setOpen(false);'));

// 4. The active language is marked in the menu.
check('active language gets a Check mark', component.includes('<Check '));
check('menu items are menuitemradio with aria-checked',
  component.includes('role="menuitemradio"') && component.includes('aria-checked={lang === l.code}'));

// 5. Both headers use the shared dropdown with the same switching
//    logic as before (setLang), and the old inline buttons are gone.
check('main page uses LanguageDropdown',
  mainPage.includes('<LanguageDropdown lang={lang} onChange={setLang} />'));
check('admin page uses LanguageDropdown',
  adminPage.includes('<LanguageDropdown lang={lang} onChange={setLang} />'));
check('main page has no old three-button switcher',
  !mainPage.includes('أزرار اللغات الثلاث'));
check('admin page has no old three-button switcher',
  !adminPage.includes("(['ar', 'tr', 'en'] as Language[]).map((l) => ("));

// 6. Menu aligns to the button's end edge (correct in RTL and LTR).
check('menu uses end-0 positioning', component.includes('absolute end-0 top-full'));

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
