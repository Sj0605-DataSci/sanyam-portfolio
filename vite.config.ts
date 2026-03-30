import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        journey: resolve(__dirname, "journey.html"),
        projects: resolve(__dirname, "projects.html"),
        blogs: resolve(__dirname, "blogs.html"),
        life: resolve(__dirname, "life.html"),
        agent: resolve(__dirname, "agent.html"),
      },
    },
  },
});
