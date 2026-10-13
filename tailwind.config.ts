import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    // 👇 여기가 제일 중요합니다! Tailwind가 감시할 폴더들입니다.
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}", // 👈 이 줄이 없어서 스타일이 안 먹혔던 겁니다!
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        accent: "var(--color-accent)",
        "accent-glow": "var(--color-accent-glow)",
        "accent-dim": "var(--color-accent-dim)",
        "bg-base": "var(--color-bg-base)",
        "bg-surface": "var(--color-bg-surface)",
        "bg-elevated": "var(--color-bg-elevated)",
        "bg-hover": "var(--color-bg-hover)",
        "border-default": "var(--color-border)",
        "border-subtle": "var(--color-border-subtle)",
        "text-primary": "var(--color-text-primary)",
        "text-secondary": "var(--color-text-secondary)",
        "text-muted": "var(--color-text-muted)",
        "text-auxiliary": "rgba(255, 255, 255, 0.65)",
      },
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "gradient-conic":
          "conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))",
      },
    },
  },
  plugins: [],
};
export default config;