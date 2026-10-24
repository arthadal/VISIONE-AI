# Collaudo nella VM «VISIONE-PC-vergine» (17/10/2026): clic DENTRO la VM con il mouse virtuale di VirtualBox
# (API COM), senza muovere il mouse del PC. Coordinate in pixel della foto di vm-foto.ps1.
# Uso: tools/vm/vm-clic.ps1 -X 100 -Y 200 [-Doppio] [-Destro]
# La tastiera si manda con `VBoxManage controlvm VISIONE-PC-vergine keyboardputstring '...'` (l'ospite ha la
# tastiera USA) o `keyboardputscancode` (es. Invio = 1c 9c, PagGiù = e0 51 e0 d1, Win = e0 5b e0 db).
param([int]$X, [int]$Y, [switch]$Doppio, [switch]$Destro)
$vbox = New-Object -ComObject VirtualBox.VirtualBox
$session = New-Object -ComObject VirtualBox.Session
$machine = $vbox.FindMachine('VISIONE-PC-vergine')
$machine.LockMachine($session, 1)  # 1 = condiviso: la VM resta accesa
try {
  $mouse = $session.Console.Mouse
  # PutMouseEventAbsolute vuole coordinate a partire da 1.
  $px = $X + 1; $py = $Y + 1
  $btn = if ($Destro) { 2 } else { 1 }
  $mouse.PutMouseEventAbsolute($px, $py, 0, 0, 0)
  Start-Sleep -Milliseconds 120
  $times = if ($Doppio) { 2 } else { 1 }
  for ($i = 0; $i -lt $times; $i++) {
    $mouse.PutMouseEventAbsolute($px, $py, 0, 0, $btn); Start-Sleep -Milliseconds 60
    $mouse.PutMouseEventAbsolute($px, $py, 0, 0, 0); Start-Sleep -Milliseconds 90
  }
  "clic a $X,$Y"
} finally { $session.UnlockMachine() }
