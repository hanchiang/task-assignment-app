// Lint config. The import/no-restricted-paths zones enforce docs/frontend.md → Components:
// app imports features; features import only api, components and lib (and `test`, from test files);
// features never import each other.
import { readdirSync } from "node:fs";
import path from "node:path";
import js from "@eslint/js";
import importPlugin from "eslint-plugin-import";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

const sharedFolders = ["./src/api", "./src/components", "./src/lib"];

// Read from disk, so a new feature folder is covered without touching this file.
const featureNames = readdirSync(path.join(import.meta.dirname, "src/features"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const featurePath = (name) => `./src/features/${name}`;

// Each feature may not import any other feature.
const featureIsolationZones = featureNames.map((name) => ({
  target: featurePath(name),
  from: featureNames.filter((other) => other !== name).map(featurePath),
  message: "Features never import each other.",
}));

const importZones = [
  { target: sharedFolders, from: ["./src/features", "./src/app"], message: "Shared code never imports a feature or the app." },
  { target: "./src/features", from: "./src/app", message: "Features never import the app layer." },
  ...featureIsolationZones.filter((zone) => zone.from.length > 0),
];

export default tseslint.config(
  { ignores: ["dist", "node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { import: importPlugin, "react-hooks": reactHooks },
    settings: { "import/resolver": { node: { extensions: [".ts", ".tsx", ".js"] } } },
    rules: {
      "import/no-restricted-paths": ["error", { zones: importZones }],
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
);
