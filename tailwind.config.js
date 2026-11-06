/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        cinema: {
          bg: "#0a0b0e",
          surface: "rgba(22, 24, 29, 0.62)",
          surfaceHover: "#13151a",
          solid: "#13151a",
          gold: "#d3b579",
          goldHover: "#e2c68f",
          goldDeep: "#b58c4f",
          goldDim: "rgba(211, 181, 121, 0.15)",
          cyan: "#63b8ab",
          cyanDim: "rgba(99, 184, 171, 0.15)",
          danger: "#e0645e",
          dangerDim: "rgba(224, 100, 94, 0.15)",
          success: "#6fbf8a",
          purple: "#a58fd0",
          text: "#eef0f2",
          textMuted: "#8b9099",
          textTertiary: "#676c75",
          ink: "#10120f",
        },
      },
      fontFamily: {
        display: ['"Playfair Display"', "Georgia", "serif"],
        body: ['"Plus Jakarta Sans"', '"Inter"', "sans-serif"],
        mono: ['"JetBrains Mono"', "monospace"],
      },
      boxShadow: {
        glowGold: "0 0 20px rgba(211, 181, 121, 0.25)",
        glowCyan: "0 0 20px rgba(99, 184, 171, 0.22)",
        glass: "0 8px 32px 0 rgba(0, 0, 0, 0.55)",
      },
      animation: {
        "pulse-slow": "pulse 4s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        shimmer: "shimmer 2s linear infinite",
      },
      keyframes: {
        shimmer: {
          "0%": { backgroundPosition: "-1000px 0" },
          "100%": { backgroundPosition: "1000px 0" },
        },
      },
    },
  },
  plugins: [],
};
