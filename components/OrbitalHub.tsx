'use client';

import React, { useState } from 'react';
import { Sparkles } from 'lucide-react';

export type SourceFilter =
  | 'all'
  | 'youtube'
  | 'pdf'
  | 'word'
  | 'instagram'
  | 'tiktok'
  | 'linkedin'
  | 'x'
  | 'telegram';

interface OrbitalHubProps {
  selectedSource: SourceFilter;
  onSelectSource: (source: SourceFilter) => void;
  counts: Record<SourceFilter, number>;
  lang: 'ar' | 'tr' | 'en';
}

interface OrbitNode {
  id: SourceFilter;
  label: string;
  ring: 'inner' | 'outer';
  angle: number; // الزاوية الابتدائية بالدرجات
  glowColor: string;
  icon: React.ReactNode;
}

const ORBIT_NODES: OrbitNode[] = [
  // المدار الداخلي (4 أيقونات)
  {
    id: 'youtube',
    label: 'YouTube',
    ring: 'inner',
    angle: 0,
    glowColor: 'shadow-[0_0_20px_rgba(239,68,68,0.55)] border-red-400/60',
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5 fill-red-500">
        <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
      </svg>
    ),
  },
  {
    id: 'pdf',
    label: 'PDF',
    ring: 'inner',
    angle: 90,
    glowColor: 'shadow-[0_0_20px_rgba(244,63,94,0.55)] border-rose-400/60',
    icon: (
      <div className="flex flex-col items-center justify-center leading-none">
        <span className="text-[10px] font-black tracking-tighter text-rose-400">PDF</span>
        <div className="w-3.5 h-0.5 bg-rose-400/80 rounded-full mt-0.5" />
      </div>
    ),
  },
  {
    id: 'telegram',
    label: 'Telegram',
    ring: 'inner',
    angle: 180,
    glowColor: 'shadow-[0_0_20px_rgba(56,189,248,0.55)] border-sky-400/60',
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5 fill-sky-400">
        <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
      </svg>
    ),
  },
  {
    id: 'word',
    label: 'Word',
    ring: 'inner',
    angle: 270,
    glowColor: 'shadow-[0_0_20px_rgba(59,130,246,0.55)] border-blue-400/60',
    icon: (
      <div className="flex flex-col items-center justify-center leading-none">
        <span className="text-xs font-black text-blue-400">W</span>
        <div className="w-3 h-0.5 bg-blue-400/80 rounded-full mt-0.5" />
      </div>
    ),
  },

  // المدار الخارجي (4 أيقونات)
  {
    id: 'instagram',
    label: 'Instagram',
    ring: 'outer',
    angle: 45,
    glowColor: 'shadow-[0_0_20px_rgba(236,72,153,0.55)] border-pink-400/60',
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5 fill-pink-400">
        <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z" />
      </svg>
    ),
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    ring: 'outer',
    angle: 135,
    glowColor: 'shadow-[0_0_20px_rgba(45,212,191,0.55)] border-teal-300/60',
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5 fill-teal-300">
        <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1-.1z" />
      </svg>
    ),
  },
  {
    id: 'linkedin',
    label: 'LinkedIn',
    ring: 'outer',
    angle: 225,
    glowColor: 'shadow-[0_0_20px_rgba(96,165,250,0.55)] border-blue-300/60',
    icon: (
      <svg viewBox="0 0 24 24" className="w-4 h-4 fill-blue-400">
        <path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14m-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.28 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93h2.75M6.88 8.56a1.68 1.68 0 0 0 1.68-1.68c0-.93-.75-1.69-1.68-1.69a1.69 1.69 0 0 0-1.69 1.69c0 .93.76 1.68 1.69 1.68m1.39 9.94v-8.37H5.5v8.37h2.77z" />
      </svg>
    ),
  },
  {
    id: 'x',
    label: 'X',
    ring: 'outer',
    angle: 315,
    glowColor: 'shadow-[0_0_20px_rgba(251,191,36,0.55)] border-amber-300/60',
    icon: (
      <svg viewBox="0 0 24 24" className="w-4 h-4 fill-white">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
      </svg>
    ),
  },
];

export default function OrbitalHub({
  selectedSource,
  onSelectSource,
  counts,
  lang,
}: OrbitalHubProps) {
  const [isPaused, setIsPaused] = useState(false);

  const innerNodes = ORBIT_NODES.filter((n) => n.ring === 'inner');
  const outerNodes = ORBIT_NODES.filter((n) => n.ring === 'outer');

  return (
    <div className="relative flex flex-col items-center justify-center my-6 select-none">
      {/* أنماط الحركة المدارية الملساء */}
      <style jsx>{`
        @keyframes orbitCW {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(360deg);
          }
        }
        @keyframes orbitCCW {
          from {
            transform: rotate(360deg);
          }
          to {
            transform: rotate(0deg);
          }
        }
        .animate-orbit-cw {
          animation: orbitCW 34s linear infinite;
        }
        .animate-orbit-ccw {
          animation: orbitCCW 46s linear infinite;
        }
        .animate-counter-cw {
          animation: orbitCCW 34s linear infinite;
        }
        .animate-counter-ccw {
          animation: orbitCW 46s linear infinite;
        }
        .paused-orbit {
          animation-play-state: paused !important;
        }
      `}</style>

      {/* حاوية المجرة المدارية */}
      <div
        onMouseEnter={() => setIsPaused(true)}
        onMouseLeave={() => setIsPaused(false)}
        className="relative w-[310px] h-[310px] sm:w-[370px] sm:h-[370px] flex items-center justify-center"
      >
        {/* هالة سديمية متوهجة خلف المجرة */}
        <div className="absolute inset-6 rounded-full bg-gradient-to-tr from-purple-600/25 via-fuchsia-500/15 to-amber-400/20 blur-2xl pointer-events-none" />

        {/* المدار الخارجي (Ring 2) */}
        <div
          className={`absolute inset-0 rounded-full border border-fuchsia-500/25 shadow-[inset_0_0_25px_rgba(192,38,211,0.12)] animate-orbit-ccw ${
            isPaused ? 'paused-orbit' : ''
          }`}
        >
          {outerNodes.map((node) => {
            const isSelected = selectedSource === node.id;
            const count = counts[node.id] || 0;
            return (
              <div
                key={node.id}
                style={{
                  transform: `rotate(${node.angle}deg) translateY(-155px) rotate(-${node.angle}deg)`,
                }}
                className="hidden sm:flex absolute top-1/2 left-1/2 -ml-6 -mt-6 w-12 h-12 items-center justify-center"
              >
                <button
                  type="button"
                  onClick={() => onSelectSource(isSelected ? 'all' : node.id)}
                  title={`${node.label} (${count})`}
                  className={`w-12 h-12 rounded-2xl bg-[#140a2b]/90 backdrop-blur-xl border flex flex-col items-center justify-center transition-transform duration-300 hover:scale-125 cursor-pointer animate-counter-ccw ${
                    isPaused ? 'paused-orbit' : ''
                  } ${
                    isSelected
                      ? 'ring-2 ring-amber-400 scale-115 bg-purple-900/90 shadow-[0_0_25px_rgba(251,191,36,0.75)]'
                      : `${node.glowColor} hover:border-amber-400`
                  }`}
                >
                  {node.icon}
                  {count > 0 && (
                    <span className="absolute -top-1.5 -end-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-amber-400 text-[#140A26] text-[10px] font-extrabold flex items-center justify-center shadow">
                      {count}
                    </span>
                  )}
                </button>
              </div>
            );
          })}

          {/* نسخة الموبايل للمدار الخارجي (نصف قطر أصغر) */}
          {outerNodes.map((node) => {
            const isSelected = selectedSource === node.id;
            const count = counts[node.id] || 0;
            return (
              <div
                key={`${node.id}-mob`}
                style={{
                  transform: `rotate(${node.angle}deg) translateY(-130px) rotate(-${node.angle}deg)`,
                }}
                className="flex sm:hidden absolute top-1/2 left-1/2 -ml-5 -mt-5 w-10 h-10 items-center justify-center"
              >
                <button
                  type="button"
                  onClick={() => onSelectSource(isSelected ? 'all' : node.id)}
                  className={`w-10 h-10 rounded-xl bg-[#140a2b]/90 backdrop-blur-xl border flex items-center justify-center cursor-pointer animate-counter-ccw ${
                    isPaused ? 'paused-orbit' : ''
                  } ${
                    isSelected
                      ? 'ring-2 ring-amber-400 bg-purple-900/90'
                      : node.glowColor
                  }`}
                >
                  {node.icon}
                  {count > 0 && (
                    <span className="absolute -top-1 -end-1 w-4 h-4 rounded-full bg-amber-400 text-[#140A26] text-[9px] font-extrabold flex items-center justify-center">
                      {count}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>

        {/* المدار الداخلي (Ring 1) */}
        <div
          className={`absolute inset-12 sm:inset-14 rounded-full border border-amber-400/30 shadow-[inset_0_0_20px_rgba(251,191,36,0.12)] animate-orbit-cw ${
            isPaused ? 'paused-orbit' : ''
          }`}
        >
          {innerNodes.map((node) => {
            const isSelected = selectedSource === node.id;
            const count = counts[node.id] || 0;
            return (
              <div
                key={node.id}
                style={{
                  transform: `rotate(${node.angle}deg) translateY(-112px) rotate(-${node.angle}deg)`,
                }}
                className="hidden sm:flex absolute top-1/2 left-1/2 -ml-6 -mt-6 w-12 h-12 items-center justify-center"
              >
                <button
                  type="button"
                  onClick={() => onSelectSource(isSelected ? 'all' : node.id)}
                  title={`${node.label} (${count})`}
                  className={`w-12 h-12 rounded-2xl bg-[#160b30]/95 backdrop-blur-xl border flex items-center justify-center transition-transform duration-300 hover:scale-125 cursor-pointer animate-counter-cw ${
                    isPaused ? 'paused-orbit' : ''
                  } ${
                    isSelected
                      ? 'ring-2 ring-amber-400 scale-115 bg-purple-900/95 shadow-[0_0_25px_rgba(251,191,36,0.75)]'
                      : `${node.glowColor} hover:border-amber-400`
                  }`}
                >
                  {node.icon}
                  {count > 0 && (
                    <span className="absolute -top-1.5 -end-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-amber-400 text-[#140A26] text-[10px] font-extrabold flex items-center justify-center shadow">
                      {count}
                    </span>
                  )}
                </button>
              </div>
            );
          })}

          {/* نسخة الموبايل للمدار الداخلي */}
          {innerNodes.map((node) => {
            const isSelected = selectedSource === node.id;
            const count = counts[node.id] || 0;
            return (
              <div
                key={`${node.id}-mob`}
                style={{
                  transform: `rotate(${node.angle}deg) translateY(-92px) rotate(-${node.angle}deg)`,
                }}
                className="flex sm:hidden absolute top-1/2 left-1/2 -ml-5 -mt-5 w-10 h-10 items-center justify-center"
              >
                <button
                  type="button"
                  onClick={() => onSelectSource(isSelected ? 'all' : node.id)}
                  className={`w-10 h-10 rounded-xl bg-[#160b30]/95 backdrop-blur-xl border flex items-center justify-center cursor-pointer animate-counter-cw ${
                    isPaused ? 'paused-orbit' : ''
                  } ${
                    isSelected
                      ? 'ring-2 ring-amber-400 bg-purple-900/95'
                      : node.glowColor
                  }`}
                >
                  {node.icon}
                  {count > 0 && (
                    <span className="absolute -top-1 -end-1 w-4 h-4 rounded-full bg-amber-400 text-[#140A26] text-[9px] font-extrabold flex items-center justify-center">
                      {count}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>

        {/* النواة المركزية (الشمس - شعار LinkMind) */}
        <button
          type="button"
          onClick={() => onSelectSource('all')}
          title={lang === 'ar' ? 'عرض جميع المصادر' : 'Show All Sources'}
          className={`relative z-10 w-24 h-24 sm:w-28 sm:h-28 rounded-full bg-gradient-to-br from-[#230e4a] via-[#130729] to-[#2e0b42] border-2 flex flex-col items-center justify-center transition duration-300 cursor-pointer group ${
            selectedSource === 'all'
              ? 'border-amber-400 shadow-[0_0_40px_rgba(251,191,36,0.55)]'
              : 'border-purple-400/50 hover:border-amber-400 shadow-[0_0_30px_rgba(168,85,247,0.45)]'
          }`}
        >
          <img
            src="/logo.png"
            alt="LinkMind Core"
            className="w-12 h-12 sm:w-14 sm:h-14 rounded-2xl object-cover border border-amber-400/50 group-hover:scale-110 transition duration-300 shadow-[0_0_15px_rgba(251,191,36,0.4)]"
          />
          <span className="mt-1.5 text-[10px] font-extrabold tracking-wider uppercase text-amber-300 flex items-center gap-0.5">
            <Sparkles className="w-2.5 h-2.5 text-amber-400" />
            {selectedSource === 'all'
              ? lang === 'ar'
                ? `الكل (${counts.all || 0})`
                : `ALL (${counts.all || 0})`
              : selectedSource.toUpperCase()}
          </span>
        </button>
      </div>

      {/* شريط توضيحي أسفل المجرة */}
      <div className="mt-2 flex items-center gap-2 text-xs text-purple-200/80 bg-[#120926]/80 border border-purple-500/25 px-4 py-1.5 rounded-full backdrop-blur-md">
        <span>
          {selectedSource === 'all'
            ? lang === 'ar'
              ? 'اضغط على أي أيقونة في المدار لعرض ملفاتها المحفوظة'
              : lang === 'tr'
              ? 'Kayıtlı dosyaları filtrelemek için yörüngedeki bir simgeye tıklayın'
              : 'Click any orbiting icon to filter its saved resources'
            : lang === 'ar'
            ? `تصفية حسب: ${selectedSource.toUpperCase()}`
            : `Filtered by: ${selectedSource.toUpperCase()}`}
        </span>
        {selectedSource !== 'all' && (
          <button
            type="button"
            onClick={() => onSelectSource('all')}
            className="text-amber-400 hover:text-amber-300 font-bold underline cursor-pointer"
          >
            {lang === 'ar' ? 'إلغاء' : 'Reset'}
          </button>
        )}
      </div>
    </div>
  );
}