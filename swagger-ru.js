(function () {
  const translations = new Map([
    ['Authorize', 'Авторизация'],
    ['Available authorizations', 'Доступные способы авторизации'],
    ['Name', 'Название'],
    ['In', 'Расположение'],
    ['Value', 'Значение'],
    ['Logout', 'Выйти'],
    ['Close', 'Закрыть'],
    ['Schemas', 'Схемы'],
    ['Models', 'Модели'],
    ['Parameters', 'Параметры'],
    ['No parameters', 'Параметры отсутствуют'],
    ['Request body', 'Тело запроса'],
    ['Request URL', 'URL запроса'],
    ['Request duration', 'Время выполнения запроса'],
    ['Responses', 'Ответы'],
    ['Response content type', 'Тип содержимого ответа'],
    ['Server response', 'Ответ сервера'],
    ['Response body', 'Тело ответа'],
    ['Response headers', 'Заголовки ответа'],
    ['Code', 'Код'],
    ['Details', 'Описание'],
    ['Description', 'Описание'],
    ['Links', 'Ссылки'],
    ['Try it out', 'Попробовать'],
    ['Cancel', 'Отмена'],
    ['Execute', 'Выполнить'],
    ['Clear', 'Очистить'],
    ['Download', 'Скачать'],
    ['Example Value', 'Пример'],
    ['Schema', 'Схема'],
    ['Media type', 'Тип данных'],
    ['Controls Accept header.', 'Значение заголовка Accept.'],
    ['Parameter content type', 'Тип данных параметра'],
    ['No links', 'Ссылок нет'],
    ['Loading', 'Загрузка'],
    ['Servers', 'Серверы'],
    ['Server', 'Сервер'],
    ['Generated server url', 'Сформированный URL сервера'],
    ['Filter by tag', 'Фильтр по разделам'],
    ['Select a definition', 'Выберите схему'],
    ['Expand operation', 'Развернуть операцию'],
    ['Collapse operation', 'Свернуть операцию'],
    ['Copy to clipboard', 'Копировать в буфер обмена'],
    ['Copy', 'Копировать'],
    ['Copied', 'Скопировано'],
    ['required', 'обязательно'],
    ['Deprecated', 'Устарело'],
    ['Default', 'По умолчанию'],
    ['Scopes', 'Области доступа'],
    ['Select all', 'Выбрать все'],
    ['Unselect all', 'Снять выделение'],
    ['Network Error', 'Ошибка сети'],
    ['Failed to fetch.', 'Не удалось выполнить запрос.'],
    ['Possible Reasons:', 'Возможные причины:'],
    ['Network Failure', 'Сбой сети'],
    ['Auth error', 'Ошибка авторизации'],
    ['No operations defined in spec!', 'В спецификации нет операций.']
  ]);

  function translateValue(value) {
    if (!value) return value;
    const trimmed = value.trim();
    const translated = translations.get(trimmed);
    if (!translated) return value;
    return value.replace(trimmed, translated);
  }

  function translateElement(root) {
    if (root.nodeType === Node.TEXT_NODE) {
      const translated = translateValue(root.nodeValue);
      if (translated !== root.nodeValue) root.nodeValue = translated;
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE) return;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let textNode;
    while ((textNode = walker.nextNode())) {
      const translated = translateValue(textNode.nodeValue);
      if (translated !== textNode.nodeValue) textNode.nodeValue = translated;
    }

    for (const element of [root, ...root.querySelectorAll('[title], [aria-label], [placeholder]')]) {
      for (const attribute of ['title', 'aria-label', 'placeholder']) {
        if (!element.hasAttribute(attribute)) continue;
        const value = element.getAttribute(attribute);
        const translated = translateValue(value);
        if (translated !== value) element.setAttribute(attribute, translated);
      }
    }
  }

  window.installSwaggerRu = function () {
    document.documentElement.lang = 'ru';
    const root = document.getElementById('swagger-ui');
    if (!root) return;
    translateElement(root);
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'characterData') translateElement(mutation.target);
        for (const node of mutation.addedNodes) translateElement(node);
      }
    }).observe(root, { childList: true, characterData: true, subtree: true });
  };
})();
