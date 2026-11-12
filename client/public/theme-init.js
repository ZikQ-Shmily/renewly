(function () {
  var preference = "system";
  try {
    var saved = window.localStorage.getItem("renewly:appearance");
    if (saved === "light" || saved === "dark") preference = saved;
  } catch (_) {}

  var systemDark = true;
  try {
    systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch (_) {}

  var resolved = preference === "system" ? (systemDark ? "dark" : "light") : preference;
  var background = resolved === "light" ? "#f4f6fb" : "#0d1120";
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  document.documentElement.style.backgroundColor = background;
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", background);
})();
