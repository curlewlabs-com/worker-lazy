// Proves the package's runtime entry bundles to the primitive alone. The package
// exists for what a Worker evaluates at isolate start, so the lint and test
// entries must stay out of its bundle. This runs against an installed tarball
// to exercise the same export resolution as a consumer's bundler.
//
//   node scripts/check-runtime-bundle.ts <directory the packed tarball is installed in>
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { build } from "esbuild";

const consumerDir = process.argv[2];
if (consumerDir === undefined) {
  throw new Error("usage: check-runtime-bundle.ts <consumer directory>");
}
const absWorkingDir = resolve(consumerDir);

const result = await build({
  stdin: {
    contents:
      'export { attemptToCrashTheIsolate, lazy, LOAD_FAILURE_MARKER, TERMINATING_MARKER, withLazy } from "@curlewlabs-com/worker-lazy";',
    resolveDir: absWorkingDir,
    loader: "js",
  },
  absWorkingDir,
  bundle: true,
  format: "esm",
  // Workers resolve package exports with these conditions; "neutral" adds no
  // Node or browser main-field fallbacks the runtime would not use.
  platform: "neutral",
  conditions: ["workerd", "worker", "browser"],
  minify: true,
  metafile: true,
  write: false,
});

const inputs = Object.keys(result.metafile.inputs)
  .filter((input) => input !== "<stdin>")
  .sort();
assert.deepEqual(inputs, [
  "node_modules/@curlewlabs-com/worker-lazy/dist/lazy.js",
  "node_modules/@curlewlabs-com/worker-lazy/dist/terminator-trap.js",
]);

const [output] = result.outputFiles;
assert.ok(output !== undefined);
// A string only the lint entry holds: a second guard, independent of the
// metafile, that none of it was inlined.
assert.ok(!output.text.includes("deferred-loading static-edge"));

console.log(
  `runtime entry bundles only ${inputs.join(", ")}: ${output.contents.byteLength} bytes minified`,
);
