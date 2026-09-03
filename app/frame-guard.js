(function () {
  'use strict';

  if (window.top === window.self) return;

  // Не даём нажимать элементы админки, если её открыли внутри чужой страницы.
  document.documentElement.hidden = true;
  try {
    window.top.location.replace(window.self.location.href);
  } catch {
    // Браузер может запретить переход верхнего окна — скрытая страница остаётся безопасной.
  }
})();
