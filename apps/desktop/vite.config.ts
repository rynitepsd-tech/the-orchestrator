import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri serves the built assets from ../dist and expects a fixed dev port.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { outDir: "dist", target: "safari15", sourcemap: false },
});
