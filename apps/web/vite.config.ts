import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "");

  return {
    root: "apps/web",
    envDir: process.cwd(),
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy: environment.VITE_RELAYER_URL
        ? undefined
        : {
            "/api": {
              target: "http://localhost:8787",
              changeOrigin: true,
              rewrite: (path) => path.replace(/^\/api/, ""),
            },
          },
    },
    build: {
      outDir: "../../dist/web",
      emptyOutDir: true,
    },
  };
});
