import type { Config } from "tailwindcss";

export default {
  darkMode: "class",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/features/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        canvas: "var(--ic-canvas)",
        surface: {
          DEFAULT: "var(--ic-surface)",
          muted: "var(--ic-surface-muted)",
        },
        input: "var(--ic-input)",
        overlay: "var(--ic-overlay)",
        skeleton: "var(--ic-skeleton)",
        muted: "var(--ic-muted)",
        subtle: "var(--ic-subtle)",
        border: {
          DEFAULT: "var(--ic-border)",
          strong: "var(--ic-border-strong)",
        },
        primary: {
          DEFAULT: "var(--ic-primary)",
          hover: "var(--ic-primary-hover)",
          soft: "var(--ic-primary-soft)",
          outline: "var(--ic-primary-outline)",
        },
        success: { DEFAULT: "var(--ic-success)", soft: "var(--ic-success-soft)" },
        danger: { DEFAULT: "var(--ic-danger)", soft: "var(--ic-danger-soft)" },
        warning: { DEFAULT: "var(--ic-warning)", soft: "var(--ic-warning-soft)", border: "var(--ic-warning-border)" },
        neutral: { soft: "var(--ic-neutral-soft)", text: "var(--ic-neutral-text)" },
        "nav-active": "var(--ic-nav-active)",
      },
      // text-* gets the readable variant of each brand/status colour (fills keep white text).
      textColor: {
        primary: { DEFAULT: "var(--ic-primary-text)" },
        success: { DEFAULT: "var(--ic-success-text)" },
        danger: { DEFAULT: "var(--ic-danger-text)" },
        warning: { DEFAULT: "var(--ic-warning-text)" },
      },
      borderRadius: {
        card: "var(--radius-card)",
        panel: "var(--radius-panel)",
        pill: "var(--radius-pill)",
      },
      boxShadow: {
        card: "var(--shadow-card)",
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
      },
    },
  },
  plugins: [],
} satisfies Config;
