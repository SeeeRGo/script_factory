function Enable-ScriptFactoryNode {
    if (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue) { return }

    foreach ($root in @($env:ProgramW6432, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if (-not $root) { continue }
        $directory = Join-Path $root 'nodejs'
        if (Test-Path -LiteralPath (Join-Path $directory 'node.exe') -PathType Leaf) {
            # The current process and its children need both node.exe and npm.cmd.
            $env:Path = $directory + ';' + $env:Path
            return
        }
    }
    throw 'Node.js 24+ was not found in PATH or Program Files\nodejs. Install it for all users on the target UN, then open a new PowerShell session.'
}
