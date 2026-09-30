import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

// CEP panels load from file:// — fix HTML for compatibility:
// 1. Strip type="module" and crossorigin (not supported over file://)
// 2. Move app script to end of body (DOM must exist before IIFE runs)
// 3. Keep CSInterface.js in head (must load before app)
function cepHtmlFix() {
  return {
    name: "cep-html-fix",
    closeBundle() {
      const htmlPath = resolve(__dirname, "dist/index.html");
      let html = readFileSync(htmlPath, "utf8");
      html = html.replace(/ type="module" crossorigin/g, "");
      html = html.replace(/ crossorigin/g, "");
      // Move app script from head to end of body
      const appScriptMatch = html.match(/<script src="\.\/assets\/index\.js"><\/script>/);
      if (appScriptMatch) {
        html = html.replace(appScriptMatch[0], "");
        html = html.replace("</body>", `  ${appScriptMatch[0]}\n  </body>`);
      }
      writeFileSync(htmlPath, html);
    },
  };
}

export default defineConfig({
  plugins: [react(), cepHtmlFix()],
  base: "./",
  build: {
    outDir: "dist",
    sourcemap: true,
    minify: false,
    emptyOutDir: true,
    rollupOptions: {
      output: {
        format: "iife",
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name].[ext]",
      },
    },
  },
});
