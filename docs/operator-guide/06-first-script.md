# Первый сценарий: создать файл и получить результат

Пример не обращается к СБИС, не подписывает и не отправляет документы. Требуется работающая УН с /health ready=true. Выполняется с любого компьютера, имеющего доступ к API, без 1С.

## Создать JSON

Сохраните как C:\Deploy\hello.json в UTF-8:

```json
{
  "format": "json-workflow",
  "title": "Мой первый сценарий",
  "context": { "message": "Проверка выполнена" },
  "steps": [
    {
      "id": "write-file",
      "title": "Создать текстовый результат",
      "action": "artifact_write",
      "params": { "filename": "hello.txt", "text": "{{message}}" }
    },
    {
      "id": "make-result",
      "title": "Сформировать реквизиты для 1С",
      "action": "compute",
      "params": { "expression": "({state:'completed',message:context.message})" },
      "save_as": "answer"
    }
  ],
  "output": { "Rezult_1": "{{answer}}" }
}
```

## Отправить и проверить

В Windows PowerShell 5.1 либо PowerShell 7:

```powershell
$base='http://АДРЕС_УН:33001'
$secure=Read-Host 'API_KEY' -AsSecureString
$credential=New-Object Management.Automation.PSCredential('api',$secure)
$headers=@{'X-API-Key'=$credential.GetNetworkCredential().Password}
$script=Get-Content C:\Deploy\hello.json -Raw -Encoding UTF8 | ConvertFrom-Json
$body=@{uid=('manual-'+[guid]::NewGuid().ToString());timeout_ms=30000;script=$script} | ConvertTo-Json -Depth 50
$created=Invoke-RestMethod "$base/api/v2/jobs" -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
$id=$created.job.job_id
$deadline=(Get-Date).AddSeconds(60)
do {
  Start-Sleep -Seconds 1
  $job=(Invoke-RestMethod "$base/api/v2/jobs/$id" -Headers $headers).job
} while($job.status -in @('queued','running','retrying') -and (Get-Date) -lt $deadline)
$job | Select-Object job_id,status,error
$job.result.Rezult_1
$job.result.artifacts | Select-Object filename,api_url
```

Ожидается success, Rezult_1.state=completed и артефакт hello.txt. Если истёк срок локального ожидания, это ещё не означает отмену задания: проверьте его по сохранённому job_id. HTTP 201 означает постановку, а не готовый результат. Не публикуйте $headers или полный секрет.

Чтобы скачать файл, используйте api_url из результата:

```powershell
$artifact=$job.result.artifacts | Where-Object filename -eq 'hello.txt' | Select-Object -First 1
if($artifact){Invoke-WebRequest ($base+$artifact.api_url) -Headers $headers -OutFile C:\Deploy\hello-result.txt}
```

Меняйте context.message и filename, запускайте с новым uid. Затем добавляйте по одному шагу, давайте ему понятные id/title. При ошибке смотрите job.error и GET /api/v2/jobs/{job_id}/logs.

## Перейти к браузеру

Готовый автономный пример: [recorder-source.json](../project-guide/examples/recorder-source.json). Он открывает локальную data:-страницу, нажимает кнопку и ждёт результат. Его можно отправить вместо hello.json тем же способом.

Для собственной страницы: DevTools → Recorder → записать действия → Replay → Export JSON. Обычную запись с steps[].type API выполняет напрямую. Для переменных/условий/файлов оберните её:

```powershell
node docs/project-guide/tools/convert-recorder.mjs recording.json workflow.json
```

Не заменяйте type:click на action:click вручную. Дальнейшие примеры, условия, циклы и перенос Recorder — [шпаргалка автора](../project-guide/01-scripts.md). Названия универсальных операций — GET /api/v2/interpreter/actions с API-ключом. Видео в комплекте нет; весь пример выше дан текстом для повторения.
