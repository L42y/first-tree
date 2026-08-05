// @vitest-environment happy-dom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OnboardingOrientation } from "../onboarding-orientation.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function renderOrientation(
  props: Partial<ComponentProps<typeof OnboardingOrientation>> = {},
): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <OnboardingOrientation
        completed={false}
        continuing={false}
        targetAgentName="Nova"
        onContinue={vi.fn()}
        {...props}
      />,
    );
  });
  return { container, root };
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("OnboardingOrientation", () => {
  it("shows the selected video, persistent chapter list, and one continue action", async () => {
    const onContinue = vi.fn();
    const { container } = await renderOrientation({ onContinue });

    expect(container.querySelector('[data-onboarding-orientation="pending"]')).not.toBeNull();
    expect(container.querySelectorAll("[data-orientation-chapter]")).toHaveLength(3);
    expect(container.textContent).toContain("Watch the short tours");
    expect(container.textContent).toContain("Context Tree");
    expect(container.textContent).toContain("GitHub automation");
    expect(container.textContent).not.toContain("Video placeholder");
    expect(container.textContent).toContain("Transcript");
    expect(container.querySelector("video")?.autoplay).toBe(false);

    const continueButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Continue with Nova",
    );
    await click(continueButton ?? null);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("plays a chapter when its persistent playlist item is clicked and marks it watched on completion", async () => {
    const onContinue = vi.fn();
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const { container } = await renderOrientation({ onContinue });
    const multiAgent = [...container.querySelectorAll<HTMLButtonElement>("[data-orientation-chapter]")].find((button) =>
      button.textContent?.includes("Multi-agent collaboration"),
    );

    await click(multiAgent ?? null);
    expect(play).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll("[data-orientation-chapter]")).toHaveLength(3);
    expect(container.textContent).toContain("The right agents join as the work unfolds");
    const video = container.querySelector("video");
    expect(video?.getAttribute("poster")).toBe("/onboarding/orientation/stills/multi-agent-poster.png");
    expect(video?.querySelector("source")?.getAttribute("src")).toBe("/onboarding/orientation/multi-agent.mp4");
    expect(video?.querySelector("track")?.getAttribute("src")).toBe("/onboarding/orientation/multi-agent.vtt");
    expect(container.textContent).toContain("Transcript");
    expect(container.textContent).not.toContain("Choose another chapter");

    await act(async () => {
      video?.dispatchEvent(new Event("ended"));
    });
    expect(multiAgent?.dataset.orientationChapterStatus).toBe("watched");

    const continueButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Continue with Nova",
    );
    await click(continueButton ?? null);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("connects the Context Tree chapter to its silent media, captions, and transcript", async () => {
    const { container } = await renderOrientation();
    const contextTree = [...container.querySelectorAll<HTMLButtonElement>("[data-orientation-chapter]")].find(
      (button) => button.textContent?.includes("Context Tree"),
    );

    await click(contextTree ?? null);
    expect(container.textContent).toContain("Read, work, review, update—then start smarter");
    const video = container.querySelector("video");
    expect(video?.getAttribute("poster")).toBe("/onboarding/orientation/stills/context-tree-poster.png");
    expect(video?.querySelector("source")?.getAttribute("src")).toBe("/onboarding/orientation/context-tree.mp4");
    expect(video?.querySelector("track")?.getAttribute("src")).toBe("/onboarding/orientation/context-tree.vtt");
    expect(container.textContent).toContain("task-relevant Context Tree paths it is authorized to use");
    expect(container.textContent).toContain("dedicated Context Reviewer");
  });

  it("connects the GitHub chapter to its supported automation media and transcript", async () => {
    const { container } = await renderOrientation();
    const github = [...container.querySelectorAll<HTMLButtonElement>("[data-orientation-chapter]")].find((button) =>
      button.textContent?.includes("GitHub automation"),
    );

    await click(github ?? null);
    expect(container.textContent).toContain("Issue-to-PR work stays connected in one Chat");
    const video = container.querySelector("video");
    expect(video?.getAttribute("poster")).toBe("/onboarding/orientation/stills/github-poster.png");
    expect(video?.querySelector("source")?.getAttribute("src")).toBe("/onboarding/orientation/github.mp4");
    expect(video?.querySelector("track")?.getAttribute("src")).toBe("/onboarding/orientation/github.vtt");
    expect(container.textContent).toContain("review, update, approval, and merge events return automatically");
    expect(container.textContent).not.toContain("review, check, approval");
  });

  it("collapses completed Orientation while keeping an explicit review path", async () => {
    const onContinue = vi.fn();
    const { container } = await renderOrientation({ completed: true, onContinue });

    expect(container.querySelector('[data-onboarding-orientation="completed"]')).not.toBeNull();
    expect(container.querySelectorAll("[data-orientation-chapter]")).toHaveLength(0);
    expect(container.textContent).not.toContain("Continue with Nova");

    const review = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Watch");
    await click(review ?? null);
    expect(container.querySelectorAll("[data-orientation-chapter]")).toHaveLength(3);
    expect(onContinue).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Continue with Nova");
  });
});
