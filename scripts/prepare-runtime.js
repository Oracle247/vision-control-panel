const fs = require("fs-extra");
const path = require("path");

const root = path.resolve(__dirname, "..");

const runtimeTemplate = path.join(root, "runtime-assets");
const runtimeRoot = path.join(root, "runtime");
const runtimeNode = path.join(runtimeRoot, "node");

console.log("Preparing Node runtime...");

// Ensure runtime folder exists
fs.ensureDirSync(runtimeRoot);

// Remove previous runtime/node
fs.removeSync(runtimeNode);

// Copy template into runtime/node
fs.copySync(runtimeTemplate, runtimeNode, {
  overwrite: true,
  errorOnExist: false,
});

console.log("Node runtime ready.");