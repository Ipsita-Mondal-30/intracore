import type { Config } from "tailwindcss";

export default {
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
        surface: "var(--ic-surface)",
        muted: "var(--ic-muted)",
        subtle: "var(--ic-subtle)",
        border: "var(--ic-border)",
        primary: {
          DEFAULT: "var(--ic-primary)",
          hover: "var(--ic-primary-hover)",
          soft: "var(--ic-primary-soft)",
          outline: "var(--ic-primary-outline)",
        },
        success: "var(--ic-success)",
        danger: "var(--ic-danger)",
        warning: "var(--ic-warning)",
        "nav-active": "var(--ic-nav-active)",
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
