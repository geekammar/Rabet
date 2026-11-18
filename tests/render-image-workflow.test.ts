import fs from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = fs.readFileSync(
  new URL("../.github/workflows/render-image.yml", import.meta.url),
  "utf8",
);

function jobBlock(name: string): string {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  expect(start, `job ${name} must exist`).toBeGreaterThanOrEqual(0);
  let end = start + 1;
  while (end < lines.length && !/^  [a-z][a-z0-9-]*:$/.test(lines[end])) {
    end += 1;
  }
  return lines.slice(start, end).join("\n");
}

describe("render-image workflow safety contract", () => {
  it("keeps automatic push release off unless the owner-enabled variable is true", () => {
    const prepare = jobBlock("prepare-release");
    expect(prepare).toMatch(
      /github\.event_name == 'push'[\s\S]*vars\.RABET_AUTO_DEPLOY_ENABLED == 'true'/,
    );
    expect(workflow).toMatch(
      /deploy_to_render:[\s\S]*type: boolean[\s\S]*default: false/,
    );
  });

  it("publishes only on a successful prepared release and never from a PR", () => {
    const publish = jobBlock("publish");
    expect(publish).toContain("needs.prepare-release.result == 'success'");
    expect(publish).toContain("github.event_name == 'workflow_dispatch'");
    expect(publish).toContain("github.event_name == 'push'");
    expect(publish).not.toContain("github.event_name == 'pull_request'");
    expect(publish).toContain("packages: write");
  });

  it("scopes the Render credential to the protected deploy job only", () => {
    const deploy = jobBlock("deploy-render");
    expect(deploy).toContain("environment:\n      name: render-production");
    expect(deploy).toContain("secrets.RENDER_API_KEY");
    expect(deploy).toContain("needs.publish.outputs.final_digest");
    expect(deploy).toContain("needs.prepare-release.outputs.repo_path");

    for (const other of [
      "verify-image",
      "release-gate-tests",
      "prepare-release",
      "publish",
    ]) {
      const block = jobBlock(other);
      expect(block).not.toContain("RENDER_API_KEY");
      expect(block).not.toContain("environment:\n      name: render-production");
    }
  });

  it("serializes release-path runs and preserves the manual path", () => {
    expect(workflow).toContain("group: ${{ github.event_name == 'pull_request'");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("PUBLISH_RENDER_IMAGE");
    expect(workflow).toContain("wait-workflows");
    expect(workflow).toContain("render-deploy-gate.mjs deploy");
  });
});
