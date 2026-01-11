/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Brand purple from logo
        brand: {
          50: '#f5f3f7',
          100: '#ebe7ef',
          200: '#d4cce0',
          300: '#b8a9c9',
          400: '#9680ad',
          500: '#7a6395',
          600: '#5d4e7a', // Primary brand color from logo
          700: '#4d4066',
          800: '#423855',
          900: '#3a3249',
          950: '#241e2e',
        },
        // Semantic colors that change with theme
        surface: {
          // Light mode surfaces
          light: {
            DEFAULT: '#ffffff',
            secondary: '#f8f7fa',
            tertiary: '#f0eef4',
            elevated: '#ffffff',
          },
          // Dark mode surfaces
          dark: {
            DEFAULT: '#1a1625',
            secondary: '#241e2e',
            tertiary: '#2d2640',
            elevated: '#322a45',
          },
        },
        // Text colors
        content: {
          light: {
            DEFAULT: '#1a1625',
            secondary: '#5d4e7a',
            tertiary: '#9680ad',
            muted: '#b8a9c9',
          },
          dark: {
            DEFAULT: '#f5f3f7',
            secondary: '#d4cce0',
            tertiary: '#9680ad',
            muted: '#7a6395',
          },
        },
        // Border colors
        border: {
          light: {
            DEFAULT: '#ebe7ef',
            secondary: '#d4cce0',
          },
          dark: {
            DEFAULT: '#3a3249',
            secondary: '#4d4066',
          },
        },
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
    },
  },
  plugins: [],
};
