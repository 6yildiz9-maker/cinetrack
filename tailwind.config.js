/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        cinema: {
          bg: "#050507",
          surface: "#121216",
          surfaceHover: "#1A1A20",
          gold: "#FFB300",
          goldDim: "rgba(255, 179, 0, 0.15)",
          cyan: "#00E5FF",
          cyanDim: "rgba(0, 229, 255, 0.15)",
          danger: "#FF453A",
          dangerDim: "rgba(255, 69, 58, 0.15)",
          text: "#F5F5F7",
          textMuted: "#86868B",
        },
      },
      fontFamily: {
        display: ['"Playfair Display"', "Georgia", "serif"],
        body: ['"Plus Jakarta Sans"', '"Inter"', "sans-serif"],
        mono: ['"JetBrains Mono"', "monospace"],
      },
      boxShadow: {
        glowGold: "0 0 20px rgba(255, 179, 0, 0.3)",
        glowCyan: "0 0 20px rgba(0, 229, 255, 0.3)",
        glass: "0 8px 32px 0 rgba(0, 0, 0, 0.37)",
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
