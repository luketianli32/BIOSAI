import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// /api is served by the Python tutor backend (python -m biosai serve)
const api = { "/api": { target: "http://127.0.0.1:8765", changeOrigin: true } };

export default defineConfig({ plugins: [react()], base: "./", server: { port: 5173, proxy: api }, preview: { proxy: api } });
