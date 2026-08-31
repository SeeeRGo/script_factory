param(
  [string]$TaskName = 'ScriptFactory-Test-UN',
  [switch]$RemoveFirewallRule
)

$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Задача $TaskName удалена. Каталоги данных и .env сохранены."
} else {
  Write-Host "Задача $TaskName не найдена."
}

if ($RemoveFirewallRule) {
  Get-NetFirewallRule -DisplayName 'Script Factory API' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  Write-Host 'Правило Windows Firewall удалено.'
}
