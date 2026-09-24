import { build, preview } from "vite";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { apiProxy, localServer } from "./vite.shared.mjs";

// Keep compilation scoped to this project. The native esbuild resolver probes
// parent directories that Windows may not permit this local sandbox to list.
// Type checking still runs separately with tsc; Rollup bundles the JS output.
const config = {
  root: fileURLToPath(new URL("./", import.meta.url)),
  configFile: false,
  esbuild: false,
  plugins: [{
    name: "qyzyljar-typescript",
    enforce: "pre",
    transform(source, id) {
      if (!/\.(ts|tsx)$/.test(id) || id.includes("node_modules")) return null;
      const result = ts.transpileModule(source, {
        fileName: id,
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, sourceMap: true },
      });
      return { code: result.outputText, map: result.sourceMapText ?? null };
    },
  }],
  build: { minify: false, cssMinify: false },
  preview: { ...localServer, proxy: apiProxy() },
};

if (process.argv[2] === "build") await build(config);
else {
  const server = await preview(config);
  server.printUrls();
  process.send?.({ type: 'ready', service: 'frontend' });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.httpServer.close(() => process.exit(0)));
}
