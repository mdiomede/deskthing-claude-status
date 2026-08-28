/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // OKLCH throughout. Neutrals are tinted toward the signal hue (~75)
        // rather than being pure grey, so the dark state and the alert state
        // read as the same object in two moods instead of two designs.
        ground: "oklch(0.155 0.008 70)",
        groundup: "oklch(0.205 0.010 70)",
        rule: "oklch(0.30 0.012 70)",
        bone: "oklch(0.93 0.012 80)",
        bonedim: "oklch(0.70 0.012 80)",
        muted: "oklch(0.52 0.012 75)",
        faint: "oklch(0.40 0.010 75)",
        // The one saturated colour. It only ever appears when a session is
        // actually waiting on a human, so its presence is the message.
        signal: "oklch(0.79 0.165 76)",
        signaldim: "oklch(0.62 0.130 76)",
      },
      fontSize: {
        // Deliberately steep steps (>=1.25) so hierarchy survives distance.
        tag: ["0.8125rem", { lineHeight: "1", letterSpacing: "0.14em" }],
        row: ["2.25rem", { lineHeight: "1.05", letterSpacing: "-0.015em" }],
        headline: ["4.25rem", { lineHeight: "0.95", letterSpacing: "-0.03em" }],
        blast: ["6.5rem", { lineHeight: "0.88", letterSpacing: "-0.04em" }],
      },
      keyframes: {
        breathe: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.82" },
        },
challenge: {
          "0%": { transform: "translateY(6px)", opacity: "0" },
          "100%": { transform: "translateY(0)", opacity: "1" },
        },
      },
      animation: {
        // Slow, no bounce. An alert may breathe; it may not bounce.
        breathe: "breathe 2.6s cubic-bezier(0.22, 1, 0.36, 1) infinite",
        rise: "challenge 420ms cubic-bezier(0.22, 1, 0.36, 1) both",
      },
    },
  },
  plugins: [],
};
