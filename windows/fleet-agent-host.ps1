param([string]$InstallDir='C:\ProgramData\ScriptFactoryAgent',[string]$NodePath)
$ErrorActionPreference='Stop'
$config=Get-Content -LiteralPath (Join-Path $InstallDir 'agent.config.json') -Raw -Encoding UTF8|ConvertFrom-Json
$mutex=New-Object Threading.Mutex($false,('Global\ScriptFactory-Fleet-Agent-'+$config.node_id))
$locked=$false
try {
 try{$locked=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$locked=$true}
 if(-not $locked){throw 'Another fleet agent already owns this node'}
 $configPath=Join-Path $InstallDir 'agent.config.json'
 $pattern=[regex]::Escape($configPath)
 if(@(Get-CimInstance Win32_Process -Filter "Name='node.exe'"|Where-Object {$_.CommandLine -imatch $pattern}).Count -gt 0){throw 'An existing agent process must be inspected before restart'}
 if(-not('ScriptFactory.WorkerJob' -as [type])){Add-Type -Path (Join-Path $InstallDir 'worker-job.cs')}
 $job=New-Object ScriptFactory.WorkerJob
 $process=$null
 try{
  $nodeArguments=@("`"$(Join-Path $InstallDir 'agent.mjs')`"","`"$configPath`"")
  foreach($name in @('agent-out.log','agent-err.log')){$log=Join-Path $config.data_dir $name;if((Test-Path $log) -and (Get-Item $log).Length -gt 1MB){Move-Item $log "$log.previous" -Force}}
  $process=Start-Process -FilePath $NodePath -ArgumentList $nodeArguments -WorkingDirectory $InstallDir -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $config.data_dir 'agent-out.log') -RedirectStandardError (Join-Path $config.data_dir 'agent-err.log')
  try{$job.Assign($process)}catch{if(-not $process.HasExited){Stop-Process -Id $process.Id -Force};throw}
  $null=$process.Handle;$process.WaitForExit();$code=$process.ExitCode
 }finally{$job.Dispose();if($process){$process.Dispose()}}
 exit $code
}finally{if($locked){$mutex.ReleaseMutex()};$mutex.Dispose()}
