export function initializeTheme() {
  if (typeof document === "undefined") return;
  const background = "#010102";
  // Keep the attribute used by theme-specific merchant icon assets.
  document.documentElement.dataset.theme = "dark";
  document.documentElement.style.colorScheme = "dark";
  document.documentElement.style.backgroundColor = background;
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute("content", background);
}
