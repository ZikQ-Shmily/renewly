(function () {
  var background = "#010102";
  document.documentElement.dataset.theme = "dark";
  document.documentElement.style.colorScheme = "dark";
  document.documentElement.style.backgroundColor = background;
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", background);
})();
