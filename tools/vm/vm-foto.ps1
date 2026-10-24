# Collaudo nella VM «VISIONE-PC-vergine» (17/10/2026): foto dello schermo dell'ospite, senza toccare il PC.
# Uso: tools/vm/vm-foto.ps1 [-Nome passo-1]  → stampa il percorso del PNG (in %TEMP%\visione-vm).
param([string]$Nome = 'vm-schermo')
$vb = 'C:\Program Files\Oracle\VirtualBox\VBoxManage.exe'
$dir = Join-Path $env:TEMP 'visione-vm'
New-Item -ItemType Directory -Force $dir | Out-Null
$png = Join-Path $dir "$Nome.png"
Remove-Item $png -ErrorAction SilentlyContinue
$ErrorActionPreference = 'Continue'
# Con lo schermo dell'ospite spento la foto fallisce (E_FAIL): un Maiusc lo sveglia.
for ($i = 0; $i -lt 3 -and -not (Test-Path $png); $i++) {
  & $vb controlvm 'VISIONE-PC-vergine' screenshotpng $png 2>$null
  if (-not (Test-Path $png)) { & $vb controlvm 'VISIONE-PC-vergine' keyboardputscancode 2a aa; Start-Sleep -Seconds 2 }
}
if (Test-Path $png) { $png } else { 'foto non riuscita' }
