/// <reference lib="dom" />

import { FileDiff, parsePatchFiles } from "@pierre/diffs";

type DiffPayload = {
  original: string;
  candidate: string;
};

const payloadElement = document.querySelector<HTMLScriptElement>("#diff-payload");
if (!payloadElement?.textContent) {
  throw new Error("Missing TinyBench diff payload");
}

const payload = JSON.parse(payloadElement.textContent) as DiffPayload;

renderPatch("#original-diff", payload.original);
renderPatch("#candidate-diff", payload.candidate);

function renderPatch(selector: string, patch: string): void {
  const target = document.querySelector<HTMLElement>(selector);
  if (!target) {
    throw new Error(`Missing diff target: ${selector}`);
  }

  target.replaceChildren();
  if (!patch.trim()) {
    target.append(emptyState("No diff captured."));
    return;
  }

  try {
    const parsed = parsePatchFiles(patch, undefined, true);
    for (const parsedPatch of parsed) {
      for (const fileDiff of parsedPatch.files) {
        const container = document.createElement("diffs-container");
        container.className = "diff-container";
        target.append(container);

        const renderer = new FileDiff({
          diffStyle: "split",
          overflow: "scroll",
          themeType: "dark",
        });
        renderer.render({ fileDiff, fileContainer: container });
      }
    }
  } catch (error) {
    const fallback = document.createElement("pre");
    fallback.className = "raw-diff";
    fallback.textContent = patch;
    target.append(fallback);
  }
}

function emptyState(message: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "empty";
  element.textContent = message;
  return element;
}
