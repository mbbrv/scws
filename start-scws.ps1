$ErrorActionPreference = 'Stop'

$adb = 'C:\Users\bebur\Downloads\scrcpy-win64-v4.0\scrcpy-win64-v4.0\adb.exe'
$node = 'C:\Users\bebur\tools\node-v22.23.1-win-x64\node.exe'
$workDir = 'C:\Users\bebur\tools\scws\packages\api'
$logDir = 'C:\Users\bebur\tools\scws\logs'

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

& $adb start-server

$env:HOST = '127.0.0.1'
$env:PORT = '9010'

Set-Location $workDir

& $node '.\index.js' `
    1>> "$logDir\stdout.log" `
    2>> "$logDir\stderr.log"

exit $LASTEXITCODE