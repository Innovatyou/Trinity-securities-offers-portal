/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/views/**/*.ejs"],
  theme: {
    extend: {
      colors: {
        navy: {
          50: "#eef3f8",
          100: "#d7e3ee",
          400: "#3d6690",
          600: "#1c4066",
          700: "#123152",
          800: "#0d2440",
          900: "#0a1a30",
        },
        gold: {
          50: "#fbf6e9",
          100: "#f3e6bf",
          400: "#d9b64f",
          500: "#c9a227",
          600: "#a9841c",
        },
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', '"Segoe UI"', "Roboto", "sans-serif"],
      },
    },
  },
  plugins: [],
};
