// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api/client.js";
import { ToastProvider } from "../toast.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const RETENTION_NOTE = "Cloud message attachments are retained for 14 days";

const imageSrcMocks = vi.hoisted(() => ({ useImageSrc: vi.fn() }));
const attachmentMocks = vi.hoisted(() => ({ downloadAttachment: vi.fn() }));

// Keep the real retention note + 404 discrimination; only the image resolver
// is stubbed so each test controls the fetch outcome directly.
vi.mock("../../../lib/use-image-src.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/use-image-src.js")>()),
  useImageSrc: imageSrcMocks.useImageSrc,
}));
vi.mock("../../../api/attachments.js", () => attachmentMocks);

let root: Root | null = null;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderLightbox(state: unknown): Promise<HTMLElement> {
  imageSrcMocks.useImageSrc.mockReturnValue(state);
  const { ImageLightbox } = await import("../image-lightbox.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ToastProvider>
        <ImageLightbox images={[{ imageId: "img-1", filename: "photo.png" }]} index={0} onIndexChange={() => {}} />
      </ToastProvider>,
    );
  });
  await flush();
  return document.body as unknown as HTMLElement;
}

function downloadButton(dom: ParentNode): HTMLButtonElement | null {
  return dom.querySelector<HTMLButtonElement>('button[aria-label="Download original"]');
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("ImageLightbox attachment availability", () => {
  it("shows the retention note and disables download when the image row is gone", async () => {
    const dom = await renderLightbox({ kind: "gone" });

    expect(dom.textContent).toContain(`"photo.png" expired or unavailable — ${RETENTION_NOTE}`);
    const download = downloadButton(dom);
    expect(download?.disabled).toBe(true);
    await act(async () => {
      download?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(attachmentMocks.downloadAttachment).not.toHaveBeenCalled();
  });

  it("keeps download working for a resolved image", async () => {
    attachmentMocks.downloadAttachment.mockResolvedValue(undefined);
    const dom = await renderLightbox({ kind: "hit", src: "data:image/png;base64,AA==" });

    const download = downloadButton(dom);
    expect(download?.disabled).toBe(false);
    await act(async () => {
      download?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(attachmentMocks.downloadAttachment).toHaveBeenCalledWith("img-1", "photo.png");
  });

  it("marks the image gone and disables download when a warm-cache download hits 404", async () => {
    attachmentMocks.downloadAttachment.mockRejectedValue(new ApiError(404, "Not Found"));
    // Cache hit: the image renders from IndexedDB, only the download reaches
    // the network and discovers the row is gone.
    const dom = await renderLightbox({ kind: "hit", src: "data:image/png;base64,AA==" });

    const download = downloadButton(dom);
    expect(download?.disabled).toBe(false);
    await act(async () => {
      download?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(downloadButton(dom)?.disabled).toBe(true);
    expect(dom.textContent).toContain(`Attachment expired or unavailable (${RETENTION_NOTE}).`);
  });

  it("reports a plain download failure for non-404 errors", async () => {
    attachmentMocks.downloadAttachment.mockRejectedValue(new ApiError(500, "Server Error"));
    const dom = await renderLightbox({ kind: "hit", src: "data:image/png;base64,AA==" });

    await act(async () => {
      downloadButton(dom)?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(downloadButton(dom)?.disabled).toBe(false);
    expect(dom.textContent).toContain("Download failed");
    expect(dom.textContent).not.toContain(RETENTION_NOTE);
  });
});
