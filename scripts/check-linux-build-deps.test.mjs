import assert from "node:assert/strict";
import test from "node:test";
import { checkLinuxBuildDependencies } from "./check-linux-build-deps.mjs";

test("accepts an environment with Linux development libraries and packaging tools", () => {
  assert.doesNotThrow(() => checkLinuxBuildDependencies(() => ({ status: 0 })));
});

test("reports missing development packages before a cached build can reach the linker", () => {
  const run = (command, args) => ({
    status: command === "pkg-config" && args[0] === "--exists"
      && ["gtk+-3.0", "webkit2gtk-4.1"].includes(args[1]) ? 1 : 0,
  });

  assert.throws(() => checkLinuxBuildDependencies(run), (error) => {
    assert.match(error.message, /^Missing Linux build dependencies: libgtk-3-dev, libwebkit2gtk-4.1-dev\./);
    assert.match(error.message, /Runtime libraries alone are insufficient/);
    assert.match(error.message, /sudo apt-get install -y/);
    return true;
  });
});

test("handles a missing pkg-config executable without misreporting every library", () => {
  const run = (command) => command === "pkg-config"
    ? { status: null, error: Object.assign(new Error("not found"), { code: "ENOENT" }) }
    : { status: 0 };

  assert.throws(() => checkLinuxBuildDependencies(run), /^Error: Missing Linux build dependencies: pkg-config\./);
});

test("reports packaging tool failures alongside missing development packages", () => {
  const run = (command, args) => ({
    status: command === "patchelf" || (command === "pkg-config" && args[1] === "librsvg-2.0") ? 1 : 0,
  });

  assert.throws(() => checkLinuxBuildDependencies(run), /^Error: Missing Linux build dependencies: librsvg2-dev, patchelf\./);
});
