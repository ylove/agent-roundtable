// Shared by the room, dashboard and serve index; all handlers live in external scripts.
export const PREVIEW_JS = String.raw`
function previewFrame(origin, id) {
  const frame = document.createElement("iframe");
  frame.className = "preview";
  frame.setAttribute("sandbox", "allow-scripts allow-forms");
  frame.referrerPolicy = "no-referrer";
  frame.title = "Preview " + id;
  frame.src = origin + "/";
  frame.loading = "lazy";
  return frame;
}
function wirePreviewButton(button, origin, id) {
  button.addEventListener("click", () => {
    if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(origin) || button.disabled) return;
    button.disabled = true;
    button.parentNode.append(previewFrame(origin, id));
    button.remove();
  });
}
function initPreviewCards() {
  for (const button of document.querySelectorAll("button[data-preview-origin]")) {
    wirePreviewButton(button, button.dataset.previewOrigin, button.dataset.previewId);
  }
}
`;
