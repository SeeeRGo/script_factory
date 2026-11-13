# Установка и обновление из закрытого репозитория

Источник проекта: `git@github.com:companyZ-1C/script_factory.git`. Закрытый репозиторий требует авторизации только на компьютере выпуска, где выполняются `git clone` и `git fetch`. Это может быть отдельный административный компьютер; размещать его на УН не требуется.

## Где требуется доступ

| Компонент | Откуда получает код | Авторизация |
| --- | --- | --- |
| Компьютер выпуска | Закрытый GitHub-репозиторий | Собственный SSH deploy key только на чтение либо GitHub-аккаунт с доступом |
| Первоначальная установка на одну/десять УН | Доставленный администратором ZIP | Права администратора Windows/WinRM; GitHub-ключ не нужен |
| Обновление одной УН вручную | Доставленный ZIP и помощник обновления | Права Windows; GitHub-ключ не нужен |
| Центральный оркестратор | Подписанный ZIP, опубликованный компьютером выпуска | FLEET_ADMIN_TOKEN при публикации |
| Агент каждой УН | Оркестратор | Индивидуальный токен агента; подпись проверяется публичным ключом релиза |

Ключ доступа к GitHub, ключ подписи релизов и токены оркестратора — разные секреты. Не передавайте GitHub-ключ в `.env` УН, ZIP, Git или настройки агента. В проекте нет параметра GITHUB_TOKEN для этой схемы, добавлять его не требуется.

## Настроить компьютер выпуска: SSH deploy key

Требуются Git for Windows и OpenSSH (`git --version`, `ssh -V`, `ssh-keygen`). Команды выполняет Windows-пользователь, который затем будет получать исходный код. Настройки другого пользователя автоматически не применяются.

1. В PowerShell создайте отдельный ключ. Не перезаписывайте существующий:

```powershell
$keyDir = Join-Path $env:USERPROFILE '.ssh'
New-Item $keyDir -ItemType Directory -Force | Out-Null
$key = Join-Path $keyDir 'script_factory_release_ed25519'
if ((Test-Path $key) -or (Test-Path ($key + '.pub'))) {
  throw 'Ключ уже существует: используйте его либо выберите другое имя'
}
ssh-keygen -t ed25519 -C 'script-factory-release' -f $key
if ($LASTEXITCODE -ne 0) { throw 'Не удалось создать SSH-ключ' }
Get-Content ($key + '.pub')
```

При создании задайте пароль ключа; для ручного выпуска его можно вводить при обращении к Git. При автоматизации отдельно настройте доступ к ключу/ssh-agent под сервисной учётной записью выпуска. Не храните пароль в скрипте.

2. Владелец репозитория открывает **Settings → Deploy keys → Add deploy key**. Добавляет содержимое файла `.pub`, например с названием `release-computer-01`. **Allow write access оставляет выключенным**: для получения исходного кода достаточно чтения. Приватный файл без `.pub` остаётся на компьютере выпуска. Для другого компьютера создайте отдельный ключ.

3. Для нового клона задайте выбранный ключ явно. Следующий пример не меняет глобальные SSH-настройки и не затирает ключи других проектов:

```powershell
$key = Join-Path $env:USERPROFILE '.ssh\script_factory_release_ed25519'
$sshCommand = 'ssh -i "' + ($key -replace '\\','/') + '" -o IdentitiesOnly=yes'
$source = 'C:\ScriptFactorySource' # отдельный каталог исходного кода, не рабочий API
if (Test-Path $source) { throw 'Для нового клона выберите отсутствующий каталог' }
git -c "core.sshCommand=$sshCommand" clone git@github.com:companyZ-1C/script_factory.git $source
if ($LASTEXITCODE -ne 0) { throw 'Не удалось получить репозиторий' }
Set-Location $source
git config --local core.sshCommand $sshCommand
if ($LASTEXITCODE -ne 0) { throw 'Не удалось сохранить выбор SSH-ключа' }
git ls-remote origin refs/heads/main
if ($LASTEXITCODE -ne 0) { throw 'Нет доступа к репозиторию' }
```

При первом подключении проверьте fingerprint GitHub по официальному списку ниже и подтвердите ключ сервера. Не отключайте проверку ключа сервера.

Если используется личный GitHub-аккаунт инженера вместо deploy key, владелец предоставляет этому аккаунту доступ, инженер принимает приглашение и настраивает свой SSH-ключ. Предоставленный SeeeRGo доступ не авторизует другие компьютеры или аккаунты автоматически.

## Перенастроить существующий клон

В каталоге исходного кода на компьютере выпуска:

```powershell
Set-Location C:\ScriptFactorySource # фактический путь существующего клона
$key = Join-Path $env:USERPROFILE '.ssh\script_factory_release_ed25519'
$sshCommand = 'ssh -i "' + ($key -replace '\\','/') + '" -o IdentitiesOnly=yes'
git config --local core.sshCommand $sshCommand
if ($LASTEXITCODE -ne 0) { throw 'Не удалось настроить SSH' }
git remote set-url origin git@github.com:companyZ-1C/script_factory.git
if ($LASTEXITCODE -ne 0) { throw 'Не удалось изменить origin' }
git fetch origin
if ($LASTEXITCODE -ne 0) { throw 'Доступ к новому репозиторию не подтверждён' }
git remote -v
git log -1 --oneline origin/main
```

Смена URL не предоставляет прав и не обновляет работающий API. Не выполняйте эти команды вместо процедуры установки пакета. Коммит для релиза выбирайте из успешно полученного `origin/main`; не полагайтесь на старую локальную ветку main после неудачного fetch.

## Собрать и доставить релиз

После успешного fetch выберите проверенный SHA:

- Для первоначальной установки или ручного обновления соберите ZIP командой `git archive` по [инструкции установки](01-install-one.md), доставьте пакет и используйте [единый установщик](11-install-or-repair.md) либо [помощник обновления](03-update-one.md).
- Для массового обновления выполните `fleet:release build` и `publish` по [инструкции](04-update-ten.md). Build использует локальный commit; publish отправляет архив в оркестратор. Агенты не скачивают файлы из GitHub.

Закрытие репозитория не меняет содержимое ZIP, проверку подписи и протокол оркестратора. На УН по-прежнему может требоваться доступ к npm registry/корпоративному зеркалу для установки зависимостей: это отдельный доступ, GitHub deploy key его не предоставляет.

Если SSH недоступен по правилам сети, можно использовать HTTPS-клон `https://github.com/companyZ-1C/script_factory.git` с Git Credential Manager и аккаунтом, имеющим доступ. Не включайте токен в URL или команды, сохраняемые в истории. Учётные данные хранятся средствами Credential Manager; команды сборки и доставки пакета остаются теми же.

## Диагностика

| Ошибка | Что проверить |
| --- | --- |
| `Permission denied (publickey)` | Приватный ключ доступен текущему Windows-пользователю; в core.sshCommand указан нужный файл; публичная часть добавлена в Deploy keys. |
| `Repository not found` / HTTP 404 | Точность адреса и права выбранного аккаунта/ключа. Закрытый репозиторий без авторизации может отвечать 404. |
| `Permission ... denied` при push | Для выпуска push не нужен. Deploy key только на чтение намеренно не разрешает запись; публикацию кода выполняет разработчик с отдельным правом записи. |
| `Host key verification failed` | Сверьте fingerprint GitHub; не очищайте known_hosts и не отключайте проверку вслепую. |
| Работает вручную, но не из планировщика | Пользователь задачи, путь к ключу, доступ к ssh-agent, ввод пароля и PATH могут отличаться от интерактивного сеанса. |
| `npm ci` не скачивает зависимости | Проверяйте npm registry, proxy и сеть независимо от GitHub-доступа. |

Доступ к исходникам проверяйте `git ls-remote origin refs/heads/main`, а не только `ssh -T`: успешная SSH-аутентификация ещё не подтверждает доступ к конкретному репозиторию. `ssh -T` у GitHub может вернуть код 1 даже при успешной аутентификации, поскольку shell-доступ не предоставляется.

Официальные инструкции GitHub: [deploy keys](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys), [создание SSH-ключа](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/generating-a-new-ssh-key-and-adding-it-to-the-ssh-agent), [fingerprints сервера](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints).
