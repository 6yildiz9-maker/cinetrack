/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        cinema: {
          bg: "#0a0b0e",
          surface: "#13151a",
          surfaceHover: "#1A1C22",
          gold: "#D3B579",
          goldDim: "rgba(211, 181, 121, 0.15)",
          cyan: "#63B8AB",
          cyanDim: "rgba(99, 184, 171, 0.15)",
          danger: "#E0645E",
          dangerDim: "rgba(224, 100, 94, 0.15)",
          text: "#EEF0F2",
          textMuted: "#8B9099",
        },
      },
      fontFamily: {
        display: ['"Playfair Display"', "Georgia", "serif"],
        body: ['"Plus Jakarta Sans"', '"Inter"', "sans-serif"],
        mono: ['"JetBrains Mono"', "monospace"],
      },
      boxShadow: {
        glowGold: "0 0 20px rgba(211, 181, 121, 0.3)",
        glowCyan: "0 0 20px rgba(99, 184, 171, 0.3)",
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
