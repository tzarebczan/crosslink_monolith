/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/renderer/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      colors: {
        accent: "#8be0c4",
        warn: "#facc15",
        bad: "#f87171",
        ok: "#4ade80",
      },
    },
  },
  plugins: [],
};
