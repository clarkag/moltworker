import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { cloudflare } from "@cloudflare/vite-plugin"

export default defineConfig({
	base: "/_admin/",
	build: {
		// Keep deploy under Worker + asset size limits (e.g. 5MB)
		sourcemap: false,
		rollupOptions: {
			output: {
				manualChunks: (id) => {
					// Split vendor chunks to avoid single huge bundle
					if (id.includes("node_modules")) {
						if (id.includes("react")) return "react";
						if (id.includes("hono")) return "hono";
					}
				},
			},
		},
	},
	plugins: [
		react(),
		cloudflare({
			configPath: "./wrangler.jsonc",
			persistState: false,
		}),
	],
})
