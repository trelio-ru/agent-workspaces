<a id="ocr-and-vision-artifacts"></a>

# Результаты OCR и визуального распознавания

Полностью прочитай файл до сохранения результата OCR/vision агента в Workspace.

Выполняй распознавание только при необходимости. Сохрани результат и соседний
`extraction-manifest.json`:

```json
{
  "schemaVersion": 1,
  "source": {
    "path": "sources/contract-scan.pdf",
    "digest": "sha256:<64 lowercase hex characters>"
  },
  "artifact": {
    "path": "derived/contract-scan/extracted-text.md",
    "type": "ocr_text"
  },
  "extraction": {
    "method": "agent-vision",
    "verificationStatus": "machine_extracted"
  },
  "warnings": ["Низкое качество страницы 7"]
}
```

Используй только `machine_extracted` или `agent_visually_checked`.
Не заявляй `human_verified`: Trelio фиксирует его лишь после подтверждения
текущего принятого результата уполномоченным человеком. Для существенных дат,
сумм, процентов, подписей и идентификаторов ссылайся на исходные страницы/изображения.

Процедура одинакова для plain/encrypted. В зашифрованном Workspace `finish`
локально проверяет manifest и точный committed source, затем печатает UUID
каждого принятого результата и пару `source -> artifact`. Покажи пару
пользователю. `verify_agent_workspace_derived_artifact` вызывай, только когда
он явно подтвердил сравнение именно этого принятого результата с именно этим
источником; предварительное разрешение теста не заменяет проверку после создания.
