/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/**/*.{ts,tsx,html}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'PingFang SC',
          'Hiragino Sans GB', 'Microsoft YaHei', 'sans-serif',
        ],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      colors: {
        ink: {
          950: '#0c0e12',
          900: '#11141a',
          850: '#161a22',
          800: '#1c212c',
          700: '#262d3b',
          600: '#333c4e',
          500: '#46536b',
          400: '#6b7a94',
          300: '#9aa8c0',
          200: '#c4cddd',
          100: '#e6eaf2',
        },
        accent: {
          DEFAULT: '#4f8cff',
          hover: '#3d78f0',
          dim: '#2b4a8f',
        },
      },
    },
  },
  plugins: [],
};
