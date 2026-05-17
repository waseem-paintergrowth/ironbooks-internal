import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Ironbooks brand
        teal: {
          DEFAULT: "#2D7A75",
          dark: "#1F5D58",
          light: "#E8F2F0",
          lighter: "#F4F9F8",
        },
        navy: {
          DEFAULT: "#0F1F2E",
          light: "#1A2B3D",
        },
        ink: {
          DEFAULT: "#0F1F2E",
          slate: "#475569",
          light: "#94A3B8",
        },
      },
      fontFamily: {
        sans: ["Figtree", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
