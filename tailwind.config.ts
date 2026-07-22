import type { Config } from 'tailwindcss'

/**
 * Design tokens for Superficialis Prep.
 *
 * Naming convention:
 *   - `surface-{n}`: background layers, from deepest (0) to highest elevation (5).
 *     Used for canvas / panels / cards / popovers — composes the elevation stack.
 *   - `ink-{n}`: foreground (text/icon) opacity steps; 1 = strongest, 5 = quietest.
 *   - `line` / `line-strong` / `line-subtle`: borders and dividers.
 *   - `accent`, `success`, `warning`, `danger`, `info`: semantic colors.
 *   - `region-*`: kept as-is, used by the 3D viewport overlays.
 *   - legacy `bg`/`border`/`accent.DEFAULT` aliases preserved so the migration
 *     stays incremental and old class names keep working.
 *
 * Typography ramp follows a 1.125 modular scale starting from 13.5px body.
 * Numerals stay in the mono family to keep tabular alignment in tree panels.
 */
const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Elevation stack (dark mode).  Designed against #08080a base so even
        // surface-0 has a hint of warm grey rather than pure black —
        // pure-black backgrounds make subpixel anti-aliased text look brittle.
        surface: {
          0: '#08080a',
          1: '#0c0c10',
          2: '#111114',
          3: '#16161b',
          4: '#1c1c22',
          5: '#23232b',
        },
        // Foreground text and icons; defined as semi-transparent so they composite over
        // any surface step without coupling to a specific bg.
        ink: {
          1: 'rgb(244 244 245)',
          2: 'rgb(212 212 216)',
          3: 'rgb(161 161 170)',
          4: 'rgb(113 113 122)',
          5: 'rgb(82 82 91)',
        },
        line: {
          DEFAULT: '#26262e',
          strong: '#33333d',
          subtle: '#1a1a20',
        },
        accent: {
          DEFAULT: '#5b8def',
          hover: '#7aa3f5',
          50:  '#eef4ff',
          100: '#d9e7ff',
          200: '#b4cfff',
          300: '#83b1ff',
          400: '#5b8def',
          500: '#3b71ea',
          600: '#2e5fd1',
          700: '#264fab',
          800: '#1e3f87',
          900: '#172f63',
        },
        success: { 50: '#ecfdf5', 500: '#10b981', 900: '#064e3b' },
        warning: { 50: '#fffbeb', 500: '#f59e0b', 900: '#78350f' },
        danger:  { 50: '#fef2f2', 500: '#ef4444', 900: '#7f1d1d' },
        info:    { 50: '#eff6ff', 500: '#3b82f6', 900: '#1e3a8a' },
        region: {
          force:   '#ef4444',
          support: '#3b82f6',
          locked:  '#737373',
          bbox:    '#22c55e',
          custom:  '#eab308',
        },
        // legacy aliases kept so the migration is painless
        bg: {
          DEFAULT:  '#08080a',
          panel:    '#0c0c10',
          elevated: '#16161b',
        },
        border: { DEFAULT: '#26262e' },
      },
      fontFamily: {
        sans: ["'Inter Variable'", 'Inter', 'system-ui', 'sans-serif'],
        mono: ["'JetBrains Mono Variable'", "'JetBrains Mono'", 'ui-monospace', 'monospace'],
      },
      fontSize: {
        '2xs':    ['10px',   { lineHeight: '14px', letterSpacing: '0.02em' }],
        'xs':     ['11px',   { lineHeight: '16px', letterSpacing: '0.01em' }],
        'sm':     ['12.5px', { lineHeight: '18px' }],
        'base':   ['13.5px', { lineHeight: '20px' }],
        'md':     ['14px',   { lineHeight: '20px' }],
        'lg':     ['15.5px', { lineHeight: '24px', letterSpacing: '-0.005em' }],
        'xl':     ['18px',   { lineHeight: '26px', letterSpacing: '-0.01em' }],
        '2xl':    ['22px',   { lineHeight: '30px', letterSpacing: '-0.015em' }],
        'display':['28px',   { lineHeight: '34px', letterSpacing: '-0.02em' }],
      },
      letterSpacing: {
        eyebrow: '0.08em',
      },
      borderRadius: {
        none: '0',
        xs: '3px',
        sm: '4px',
        md: '6px',
        lg: '8px',
        xl: '10px',
        '2xl': '14px',
      },
      boxShadow: {
        // Compound shadows for that subtle "papery" elevation
        // (Linear / Vercel / Geist UI conventions).
        e1:   '0 1px 0 0 rgba(0,0,0,0.4), 0 1px 2px 0 rgba(0,0,0,0.3)',
        e2:   '0 1px 0 0 rgba(0,0,0,0.4), 0 2px 8px -2px rgba(0,0,0,0.4)',
        e3:   '0 1px 0 0 rgba(0,0,0,0.4), 0 8px 24px -6px rgba(0,0,0,0.5)',
        e4:   '0 1px 0 0 rgba(0,0,0,0.45), 0 20px 50px -10px rgba(0,0,0,0.6)',
        glow: '0 0 0 1px rgb(91 141 239 / 0.5), 0 0 20px -2px rgb(91 141 239 / 0.35)',
      },
      transitionTimingFunction: {
        out: 'cubic-bezier(0.16, 1, 0.3, 1)',
        inOut: 'cubic-bezier(0.4, 0, 0.2, 1)',
      },
      transitionDuration: {
        instant: '0ms',
        fast:    '120ms',
        normal:  '180ms',
        slow:    '260ms',
      },
      keyframes: {
        fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideInRight: {
          '0%': { opacity: '0', transform: 'translateX(12px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        scaleIn: {
          '0%': { opacity: '0', transform: 'scale(0.96)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        fadeIn: 'fadeIn 180ms cubic-bezier(0.16, 1, 0.3, 1) both',
        slideUp: 'slideUp 220ms cubic-bezier(0.16, 1, 0.3, 1) both',
        slideInRight: 'slideInRight 220ms cubic-bezier(0.16, 1, 0.3, 1) both',
        scaleIn: 'scaleIn 180ms cubic-bezier(0.16, 1, 0.3, 1) both',
        shimmer: 'shimmer 1.6s linear infinite',
      },
      backdropBlur: {
        xs: '2px',
      },
    },
  },
  plugins: [],
}

export default config
